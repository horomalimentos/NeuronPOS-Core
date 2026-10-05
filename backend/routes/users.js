// CRUD de usuarios del restaurante (solo admin escribe; gerente puede ver).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireOperational } from '../middleware/requireModule.js';
import {
  EMAIL_RE, UUID_RE, ah, badRequest, bool, buildSet, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';

export const ROLES = ['admin', 'gerente', 'cajero', 'mesero', 'cocina', 'repartidor'];

const router = Router();
router.use(authenticateUser, requireOperational);

const SELECT_USERS = `
  SELECT u.id, u.email, u.name, u.role, u.active, u.last_login_at, u.created_at,
         coalesce(array_agg(ub.branch_id ORDER BY ub.is_primary DESC) FILTER (WHERE ub.branch_id IS NOT NULL), '{}') AS branch_ids
    FROM users u
    LEFT JOIN user_branches ub ON ub.user_id = u.id
   WHERE u.restaurant_id = $1`;

function readBranchIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => UUID_RE.test(String(v)))) {
    throw badRequest('branch_ids debe ser una lista de sucursales', 'INVALID_FIELD');
  }
  return [...new Set(value.map(String))];
}

function readPassword(value, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('La contrasena es obligatoria', 'MISSING_FIELD');
    return undefined;
  }
  if (typeof value !== 'string' || value.length < 8) {
    throw badRequest('La contrasena debe tener al menos 8 caracteres', 'WEAK_PASSWORD');
  }
  return value;
}

async function setBranches(db, restaurantId, userId, branchIds) {
  // Las FKs compuestas (restaurant_id, branch_id) impiden asignar sucursales
  // de otro restaurante; RLS ademas oculta las ajenas.
  const valid = await db.query(
    'SELECT id FROM branches WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
    [restaurantId, branchIds],
  );
  if (valid.rowCount !== branchIds.length) throw badRequest('Alguna sucursal no existe', 'BRANCH_NOT_FOUND');
  await db.query('DELETE FROM user_branches WHERE user_id = $1 AND restaurant_id = $2', [userId, restaurantId]);
  for (const [i, branchId] of branchIds.entries()) {
    await db.query(
      'INSERT INTO user_branches (restaurant_id, user_id, branch_id, is_primary) VALUES ($1, $2, $3, $4)',
      [restaurantId, userId, branchId, i === 0],
    );
  }
}

async function getUser(db, restaurantId, id) {
  const { rows } = await db.query(`${SELECT_USERS} AND u.id = $2 GROUP BY u.id`, [restaurantId, id]);
  return rows[0] || null;
}

router.get('/', requireRole('admin', 'gerente'), ah(async (req, res) => {
  const rows = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${SELECT_USERS} GROUP BY u.id ORDER BY u.name`,
    [req.tenant.id],
  )).rows);
  res.json({ users: rows });
}));

router.get('/:id', requireRole('admin', 'gerente'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const user = await withTenant(req.tenant.id, (db) => getUser(db, req.tenant.id, req.params.id));
  if (!user) throw notFound('Usuario no encontrado', 'USER_NOT_FOUND');
  res.json({ user });
}));

router.post('/', requireRole('admin'), ah(async (req, res) => {
  const body = req.body || {};
  const email = str(body.email, { field: 'email', required: true, max: 200 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Correo invalido', 'INVALID_EMAIL');
  const name = str(body.name, { field: 'name', required: true, max: 120 });
  const role = oneOf(body.role, ROLES, 'role');
  if (!role) throw badRequest('El rol es obligatorio', 'MISSING_FIELD');
  const password = readPassword(body.password, true);
  const branchIds = readBranchIds(body.branch_ids) || [];
  const hash = await bcrypt.hash(password, 12);

  const user = await withTenant(req.tenant.id, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.tenant.id, email, name, hash, role],
    );
    if (branchIds.length) await setBranches(db, req.tenant.id, rows[0].id, branchIds);
    return getUser(db, req.tenant.id, rows[0].id);
  });
  res.status(201).json({ user });
}));

router.patch('/:id', requireRole('admin'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const isSelf = req.params.id === req.user.id;
  const fields = {
    email: str(body.email, { field: 'email', max: 200 })?.toLowerCase() ?? undefined,
    name: str(body.name, { field: 'name', max: 120 }) ?? undefined,
    role: oneOf(body.role, ROLES, 'role'),
    active: bool(body.active, 'active'),
  };
  if (fields.email && !EMAIL_RE.test(fields.email)) throw badRequest('Correo invalido', 'INVALID_EMAIL');
  if (isSelf && (fields.active === false || (fields.role && fields.role !== 'admin'))) {
    throw badRequest('No puedes quitarte el rol de administrador ni desactivarte a ti mismo', 'SELF_LOCKOUT');
  }
  const password = readPassword(body.password, false);
  if (password) fields.password_hash = await bcrypt.hash(password, 12);
  const branchIds = readBranchIds(body.branch_ids);

  const user = await withTenant(req.tenant.id, async (db) => {
    const set = buildSet(fields, 3);
    if (set) {
      const { rowCount } = await db.query(
        `UPDATE users SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.tenant.id, ...set.values],
      );
      if (!rowCount) throw notFound('Usuario no encontrado', 'USER_NOT_FOUND');
    }
    const existing = await getUser(db, req.tenant.id, req.params.id);
    if (!existing) throw notFound('Usuario no encontrado', 'USER_NOT_FOUND');
    if (branchIds) await setBranches(db, req.tenant.id, req.params.id, branchIds);
    if (!set && !branchIds) throw badRequest('No hay cambios', 'NO_CHANGES');
    return getUser(db, req.tenant.id, req.params.id);
  });
  res.json({ user });
}));

router.delete('/:id', requireRole('admin'), ah(async (req, res) => {
  requireUuid(req.params.id);
  if (req.params.id === req.user.id) throw badRequest('No puedes borrar tu propia cuenta', 'SELF_LOCKOUT');
  const deleted = await withTenant(req.tenant.id, async (db) => (await db.query(
    'DELETE FROM users WHERE id = $1 AND restaurant_id = $2',
    [req.params.id, req.tenant.id],
  )).rowCount);
  if (!deleted) throw notFound('Usuario no encontrado', 'USER_NOT_FOUND');
  res.status(204).end();
}));

export default router;
