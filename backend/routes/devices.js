// Control de dispositivos (modulo "dispositivos"): el equipo pide su alta y el
// gerente la aprueba o revoca. Ver services/devices.js.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { findDevice, hashDeviceToken, readDeviceToken } from '../services/devices.js';
import { can } from '../services/permissions.js';
import { HttpError, ah, badRequest, notFound, requireUuid, str } from '../utils/http.js';
import { requireBranch } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('dispositivos'));

const COLS = `d.id, d.branch_id, b.name AS branch_name, d.name, d.terminal, d.status, d.user_agent, d.last_seen_at, d.created_at,
  d.reviewed_at, ur.name AS requested_by_name, uv.name AS reviewed_by_name`;
const SELECT = `SELECT ${COLS} FROM pos_devices d
  JOIN branches b ON b.id = d.branch_id AND b.restaurant_id = d.restaurant_id
  LEFT JOIN users ur ON ur.id = d.requested_by AND ur.restaurant_id = d.restaurant_id
  LEFT JOIN users uv ON uv.id = d.reviewed_by AND uv.restaurant_id = d.restaurant_id`;

// Este equipo: su alta (o null si no la ha pedido).
router.get('/me', ah(async (req, res) => {
  const device = await withTenant(req.tenant.id, async (db) => {
    const d = await findDevice(db, req.tenant.id, readDeviceToken(req));
    return d ? (await db.query(`${SELECT} WHERE d.id = $1`, [d.id])).rows[0] : null;
  });
  res.json({ device });
}));

// Pedir el alta de este equipo: { name, branch_id, terminal } (llave en X-Device-Token).
router.post('/request', can('cashier'), ah(async (req, res) => {
  const token = readDeviceToken(req);
  if (!token) throw badRequest('El equipo no mando su llave', 'DEVICE_TOKEN_REQUIRED');
  const b = req.body || {};
  const branchId = requireBranch(req, b.branch_id);
  const name = str(b.name, { field: 'name', required: true, max: 60 });
  const terminal = str(b.terminal, { field: 'terminal', required: true, max: 40 });
  const device = await withTenant(req.tenant.id, async (db) => {
    const cur = await findDevice(db, req.tenant.id, token);
    if (cur?.status === 'activo') throw new HttpError(409, 'Este equipo ya esta autorizado', 'DEVICE_ALREADY_ACTIVE');
    if (cur?.status === 'revocado') throw new HttpError(403, 'Este equipo fue dado de baja', 'DEVICE_REVOKED');
    const id = cur ? (await db.query(
      'UPDATE pos_devices SET name = $3, branch_id = $4, terminal = $5, requested_by = $6, user_agent = $7 WHERE id = $1 AND restaurant_id = $2 RETURNING id',
      [cur.id, req.tenant.id, name, branchId, terminal, req.user.id, String(req.headers['user-agent'] || '').slice(0, 200)],
    )).rows[0].id : (await db.query(
      `INSERT INTO pos_devices (restaurant_id, branch_id, name, terminal, token_hash, requested_by, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.tenant.id, branchId, name, terminal, hashDeviceToken(token), req.user.id, String(req.headers['user-agent'] || '').slice(0, 200)],
    )).rows[0].id;
    return (await db.query(`${SELECT} WHERE d.id = $1`, [id])).rows[0];
  });
  res.status(201).json({ device });
}));

router.get('/', can('manage'), ah(async (req, res) => {
  const devices = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${SELECT} WHERE d.restaurant_id = $1 ORDER BY d.status = 'pendiente' DESC, b.name, d.name`,
    [req.tenant.id],
  )).rows);
  res.json({ devices });
}));

async function review(req, status, extra = {}) {
  requireUuid(req.params.id);
  return withTenant(req.tenant.id, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE pos_devices SET status = $3, reviewed_by = $4, reviewed_at = now(),
              name = coalesce($5, name), terminal = coalesce($6, terminal)
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.tenant.id, status, req.user.id, extra.name ?? null, extra.terminal ?? null],
    );
    if (!rowCount) throw notFound('Equipo no encontrado', 'DEVICE_NOT_FOUND');
    return (await db.query(`${SELECT} WHERE d.id = $1`, [req.params.id])).rows[0];
  });
}

router.post('/:id/approve', can('manage'), ah(async (req, res) => {
  const b = req.body || {};
  res.json({ device: await review(req, 'activo', {
    name: str(b.name, { field: 'name', max: 60 }) || null, terminal: str(b.terminal, { field: 'terminal', max: 40 }) || null,
  }) });
}));
router.post('/:id/revoke', can('manage'), ah(async (req, res) => {
  res.json({ device: await review(req, 'revocado') });
}));
router.delete('/:id', can('manage'), ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, (db) => db.query('DELETE FROM pos_devices WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]));
  res.status(204).end();
}));

export default router;
