// CRUD de sucursales del restaurante. Cada consulta corre con withTenant
// (RLS) y ademas filtra por restaurant_id explicitamente.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { normalizeWeek } from '../services/hours.js';
import { loadBranches } from '../services/online.js';
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

// ---------------------------------------------------------------------------
// Horario semanal y dias cerrados (sitio web y pedidos en linea)
// ---------------------------------------------------------------------------

async function branchSchedule(db, restaurantId, branchId) {
  const b = (await loadBranches(db, restaurantId, { onlyActive: false })).find((x) => x.id === branchId);
  if (!b) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
  return { branch_id: b.id, timezone: b.timezone, hours: b.hours, closures: b.closures, status: b.status };
}

router.get('/:id/hours', ah(async (req, res) => {
  requireUuid(req.params.id);
  const seeAll = ['admin', 'gerente'].includes(req.user.role);
  if (!seeAll && !req.user.branch_ids.includes(req.params.id)) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
  res.json(await withTenant(req.tenant.id, (db) => branchSchedule(db, req.tenant.id, req.params.id)));
}));

function readClosures(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) throw badRequest('closures debe ser una lista', 'INVALID_FIELD');
  const seen = new Set();
  return value.map((c) => {
    const date = String(c?.closed_on || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      throw badRequest('Fecha de cierre invalida (usa AAAA-MM-DD)', 'INVALID_DATE');
    }
    if (seen.has(date)) throw badRequest(`La fecha ${date} esta repetida`, 'INVALID_FIELD');
    seen.add(date);
    return { closed_on: date, reason: str(c.reason, { field: 'reason', max: 200 }) || null };
  });
}

// Reemplaza el horario (y, si se envian, los dias cerrados) de la sucursal.
router.put('/:id/hours', requireRole('admin', 'gerente'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  let hours;
  try {
    hours = normalizeWeek(body.hours ?? []);
  } catch (err) {
    throw badRequest(err.message, 'INVALID_HOURS');
  }
  const closures = readClosures(body.closures);
  const data = await withTenant(req.tenant.id, async (db) => {
    const exists = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!exists.rowCount) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
    await db.query('DELETE FROM branch_hours WHERE branch_id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    for (const h of hours) {
      await db.query(
        `INSERT INTO branch_hours (restaurant_id, branch_id, weekday, opens_at, closes_at) VALUES ($1, $2, $3, $4, $5)`,
        [req.tenant.id, req.params.id, h.weekday, h.opens_at, h.closes_at],
      );
    }
    if (closures) {
      await db.query('DELETE FROM branch_closures WHERE branch_id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
      for (const c of closures) {
        await db.query(
          'INSERT INTO branch_closures (restaurant_id, branch_id, closed_on, reason) VALUES ($1, $2, $3, $4)',
          [req.tenant.id, req.params.id, c.closed_on, c.reason],
        );
      }
    }
    return branchSchedule(db, req.tenant.id, req.params.id);
  });
  res.json(data);
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
