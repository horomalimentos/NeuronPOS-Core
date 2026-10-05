// CRUD de sucursales del restaurante. Cada consulta corre con withTenant
// (RLS) y ademas filtra por restaurant_id explicitamente.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { ah, badRequest, bool, buildSet, notFound, requireUuid, str } from '../utils/http.js';

const router = Router();
router.use(authenticateUser);

const COLUMNS = 'id, name, address, phone, timezone, active, created_at, updated_at';

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function branchFields(body, creating) {
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 120 }),
    address: str(body.address, { field: 'address', max: 300 }),
    phone: str(body.phone, { field: 'phone', max: 40 }),
    timezone: str(body.timezone, { field: 'timezone', max: 60 }) ?? undefined,
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  if (f.timezone && !validTimezone(f.timezone)) throw badRequest('Zona horaria invalida', 'INVALID_TIMEZONE');
  return f;
}

router.get('/', ah(async (req, res) => {
  const seeAll = ['admin', 'gerente'].includes(req.user.role);
  const rows = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${COLUMNS} FROM branches
      WHERE restaurant_id = $1 AND ($2 OR id = ANY($3::uuid[]))
      ORDER BY name`,
    [req.tenant.id, seeAll, req.user.branch_ids],
  )).rows);
  res.json({ branches: rows });
}));

router.post('/', requireRole('admin', 'gerente'), ah(async (req, res) => {
  const f = branchFields(req.body || {}, true);
  const cols = Object.entries(f).filter(([, v]) => v !== undefined);
  const row = await withTenant(req.tenant.id, async (db) => (await db.query(
    `INSERT INTO branches (restaurant_id, ${cols.map(([k]) => k).join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${COLUMNS}`,
    [req.tenant.id, ...cols.map(([, v]) => v)],
  )).rows[0]);
  res.status(201).json({ branch: row });
}));

router.patch('/:id', requireRole('admin', 'gerente'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const set = buildSet(branchFields(req.body || {}, false), 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const row = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE branches SET ${set.sql}, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${COLUMNS}`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]);
  if (!row) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
  res.json({ branch: row });
}));

router.delete('/:id', requireRole('admin'), ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const count = await db.query('SELECT count(*)::int AS n FROM branches WHERE restaurant_id = $1', [req.tenant.id]);
    const { rowCount } = await db.query(
      'SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, req.tenant.id],
    );
    if (!rowCount) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
    if (count.rows[0].n <= 1) throw badRequest('El restaurante debe tener al menos una sucursal', 'LAST_BRANCH');
    await db.query('DELETE FROM branches WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
  });
  res.status(204).end();
}));

export default router;
