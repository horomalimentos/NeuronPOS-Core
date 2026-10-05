// Autenticacion JWT. Dos tipos de token que nunca se mezclan:
//   typ = 'user'     -> usuario de un restaurante (claim rid = restaurant_id)
//   typ = 'platform' -> dueno de la plataforma (Panel NeuronPOS)
// Adaptado del middleware de NeuronPOS, sin sesiones en BD por ahora.
import jwt from 'jsonwebtoken';
import pool, { withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import { HttpError, forbidden } from '../utils/http.js';
import { findRestaurantById } from './tenant.js';

const unauthorized = (msg = 'Se requiere iniciar sesion', code = 'AUTH_REQUIRED') => new HttpError(401, msg, code);

export function signUserToken(user) {
  return jwt.sign(
    { sub: user.id, typ: 'user', rid: user.restaurant_id, role: user.role },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

export function signPlatformToken(admin) {
  return jwt.sign({ sub: admin.id, typ: 'platform' }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw unauthorized('Tu sesion expiro, vuelve a entrar', 'TOKEN_EXPIRED');
    throw unauthorized('Token invalido', 'INVALID_TOKEN');
  }
}

/** Usuario de restaurante. Requiere que resolveTenant haya corrido antes. */
export async function authenticateUser(req, res, next) {
  try {
    const payload = readToken(req);
    if (payload.typ !== 'user' || !payload.rid) throw unauthorized('Token invalido', 'INVALID_TOKEN');

    if (req.tenant && req.tenant.id !== payload.rid) {
      throw forbidden('Esta sesion pertenece a otro restaurante', 'TENANT_MISMATCH');
    }
    if (!req.tenant) {
      req.tenant = await findRestaurantById(payload.rid);
      req.tenantSource = 'token';
      if (!req.tenant) throw unauthorized('Restaurante no encontrado', 'INVALID_TOKEN');
    }

    const user = await withTenant(req.tenant.id, async (db) => {
      const { rows } = await db.query(
        `SELECT u.id, u.restaurant_id, u.email, u.name, u.role, u.active,
                coalesce(array_agg(ub.branch_id) FILTER (WHERE ub.branch_id IS NOT NULL), '{}') AS branch_ids
           FROM users u
           LEFT JOIN user_branches ub ON ub.user_id = u.id
          WHERE u.id = $1 AND u.restaurant_id = $2
          GROUP BY u.id`,
        [payload.sub, req.tenant.id],
      );
      return rows[0];
    });

    if (!user) throw unauthorized('Usuario no encontrado', 'INVALID_TOKEN');
    if (!user.active) throw forbidden('Tu cuenta esta desactivada. Contacta a un administrador.', 'ACCOUNT_DEACTIVATED');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Dueno de la plataforma. */
export async function authenticatePlatform(req, res, next) {
  try {
    const payload = readToken(req);
    if (payload.typ !== 'platform') throw forbidden('Se requiere una cuenta de NeuronPOS', 'PLATFORM_ONLY');
    const { rows } = await pool.query(
      'SELECT id, email, name, active FROM platform_admins WHERE id = $1',
      [payload.sub],
    );
    const admin = rows[0];
    if (!admin || !admin.active) throw unauthorized('Cuenta no valida', 'INVALID_TOKEN');
    req.platformAdmin = admin;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(forbidden('Tu rol no tiene permiso para esta accion', 'ROLE_REQUIRED'));
  }
  next();
};
