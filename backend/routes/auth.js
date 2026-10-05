// Login de usuarios de restaurante (requiere tenant resuelto) y del dueno
// de la plataforma.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import pool, { withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import { signPlatformToken, signUserToken } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { HttpError, ah, str } from '../utils/http.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: 'Demasiados intentos de inicio de sesion. Intenta de nuevo en unos minutos.', code: 'RATE_LIMITED' },
});

const invalidCredentials = () => new HttpError(401, 'Correo o contrasena incorrectos', 'INVALID_CREDENTIALS');

// Hash de relleno para que un correo inexistente tarde lo mismo que uno real.
const DUMMY_HASH = bcrypt.hashSync('no-existe', 10);

function readCredentials(body = {}) {
  const email = str(body.email, { field: 'email', required: true, max: 200 }).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) throw new HttpError(400, 'La contrasena es obligatoria', 'MISSING_FIELD');
  return { email, password };
}

export const restaurantAuthRouter = Router();

restaurantAuthRouter.post('/login', loginLimiter, requireTenant, ah(async (req, res) => {
  const { email, password } = readCredentials(req.body);
  const user = await withTenant(req.tenant.id, async (db) => {
    const { rows } = await db.query(
      `SELECT id, restaurant_id, email, name, role, active, password_hash
         FROM users WHERE restaurant_id = $1 AND email = $2`,
      [req.tenant.id, email],
    );
    return rows[0];
  });

  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) throw invalidCredentials();
  if (!user.active) throw new HttpError(403, 'Tu cuenta esta desactivada. Contacta a un administrador.', 'ACCOUNT_DEACTIVATED');

  await withTenant(req.tenant.id, (db) =>
    db.query('UPDATE users SET last_login_at = now() WHERE id = $1 AND restaurant_id = $2', [user.id, req.tenant.id]));

  res.json({
    token: signUserToken(user),
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    restaurant: { id: req.tenant.id, slug: req.tenant.slug, name: req.tenant.name },
  });
}));

export const platformAuthRouter = Router();

platformAuthRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = readCredentials(req.body);
  const { rows } = await pool.query(
    'SELECT id, email, name, active, password_hash FROM platform_admins WHERE email = $1',
    [email],
  );
  const admin = rows[0];
  const ok = await bcrypt.compare(password, admin?.password_hash || DUMMY_HASH);
  if (!admin || !ok || !admin.active) throw invalidCredentials();
  await pool.query('UPDATE platform_admins SET last_login_at = now() WHERE id = $1', [admin.id]);
  res.json({ token: signPlatformToken(admin), admin: { id: admin.id, email: admin.email, name: admin.name } });
}));
