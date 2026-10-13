// Alertas de las apps instalables de Nayo (APK y EXE de Restaurante y
// Repartidor). Las apps nativas no reciben push web: un servicio en segundo
// plano pregunta aqui cada pocos segundos si hay pedidos sin atender y, si
// los hay, suena con su propio tono y se pone encima de las demas apps hasta
// que el pedido se acepta, se rechaza o se toma.
//
// La pagina (ya con sesion) pide un token de alertas y se lo pasa a la app.
// Ese token dura mas que la sesion (el servicio sigue sonando aunque la
// sesion web expire), pero solo sirve para GET /api/alertas: dice cuantos
// pedidos esperan, sin datos del cliente. Se invalida si la cuenta se
// desactiva o cambia su contraseña.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticateFleet, authenticateUser } from '../middleware/auth.js';
import { driverBoard } from '../services/marketplaceMoney.js';
import { composeNayoMessage } from '../services/nayoPush.js';
import { issuedBeforePasswordChange } from '../services/passwordReset.js';
import { HttpError, ah } from '../utils/http.js';

const router = Router();
export const ALERTS_AUDIENCE = 'alertas';
const ALERTS_TTL = '90d';

const unauthorized = (msg = 'Vuelve a entrar en la app', code = 'ALERTS_TOKEN_INVALID') => new HttpError(401, msg, code);

const sign = (claims) => jwt.sign({ typ: 'alertas', ...claims }, env.jwtSecret, { expiresIn: ALERTS_TTL, audience: ALERTS_AUDIENCE });

router.post('/restaurante', authenticateUser, ah(async (req, res) => {
  res.json({ token: sign({ app: 'restaurante', sub: req.user.id, rid: req.user.restaurant_id }), every_s: 8 });
}));

router.post('/repartidor', authenticateFleet, ah(async (req, res) => {
  res.json({ token: sign({ app: 'repartidor', sub: req.fleetDriver.id }), every_s: 8 });
}));

function readAlertsToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  try {
    const p = jwt.verify(token, env.jwtSecret, { audience: ALERTS_AUDIENCE });
    if (p.typ !== 'alertas' || !p.sub || !['restaurante', 'repartidor'].includes(p.app)) throw new Error('tipo');
    return p;
  } catch {
    throw unauthorized();
  }
}

/** Pedidos de Nayo que el restaurante no ha aceptado ni rechazado. */
async function restaurantAlerts(p) {
  return withPlatform(async (db) => {
    const user = (await db.query(
      'SELECT id, role, active, password_changed_at FROM users WHERE id = $1 AND restaurant_id = $2',
      [p.sub, p.rid],
    )).rows[0];
    if (!user || !user.active || issuedBeforePasswordChange(p, user.password_changed_at)) throw unauthorized();
    // Igual que los avisos push: administradores y gerentes ven todas las
    // sucursales; cajeros solo la suya.
    const rows = (await db.query(
      `SELECT m.*, o.folio, b.name AS branch_name, r.name AS restaurant_name
         FROM marketplace_orders m
         JOIN orders o ON o.id = m.order_id
         JOIN branches b ON b.id = m.branch_id
         JOIN restaurants r ON r.id = m.restaurant_id
        WHERE m.restaurant_id = $1 AND m.status = 'nuevo'
          AND ($2 IN ('admin', 'gerente')
               OR ($2 = 'cajero' AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = $3 AND ub.branch_id = m.branch_id)))
        ORDER BY m.created_at`,
      [p.rid, user.role, user.id],
    )).rows;
    return rows.map((m) => ({ id: m.id, ...composeNayoMessage({ audience: 'restaurante', kind: 'nuevo_pedido' }, m) }));
  });
}

/** Pedidos disponibles en la zona del repartidor (solo si esta en turno). */
async function driverAlerts(p) {
  const driver = await withPlatform(async (db) => (await db.query(
    'SELECT id, active, password_changed_at FROM fleet_drivers WHERE id = $1',
    [p.sub],
  )).rows[0]);
  if (!driver || !driver.active || issuedBeforePasswordChange(p, driver.password_changed_at)) throw unauthorized();
  const board = await driverBoard(driver.id);
  return board.available.map((m) => ({ id: m.id, ...composeNayoMessage({ audience: 'repartidores', kind: 'disponible' }, m) }));
}

router.get('/', ah(async (req, res) => {
  const p = readAlertsToken(req);
  const pending = p.app === 'restaurante' ? await restaurantAlerts(p) : await driverAlerts(p);
  res.set('Cache-Control', 'no-store').json({
    app: p.app,
    pending: pending.map(({ id, title, body, link }) => ({ id, title, body, link })),
  });
}));

export default router;
