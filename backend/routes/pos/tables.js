// Zonas y mesas por sucursal. Una mesa esta "ocupada" si tiene una orden
// activa (abierta, enviada o lista); no se guarda un estado aparte.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { ah, badRequest, bool, buildSet, notFound, requireUuid, str } from '../../utils/http.js';
import { ROLES, assertBranchExists, insertSql, int, requireBranch } from './common.js';

const router = Router();

const ZONE_COLS = 'id, branch_id, name, sort_order, active';
const TABLE_COLS = 'id, branch_id, zone_id, name, capacity, sort_order, active';

router.get('/tables', requireRole(...ROLES.orders), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const zones = (await db.query(
      `SELECT ${ZONE_COLS} FROM restaurant_zones WHERE restaurant_id = $1 AND branch_id = $2
        ORDER BY sort_order, name`,
      [req.tenant.id, branchId],
    )).rows;
    const tables = (await db.query(
      `SELECT ${TABLE_COLS.split(', ').map((c) => `t.${c}`).join(', ')},
              CASE WHEN o.id IS NULL THEN 'libre' ELSE 'ocupada' END AS status,
              o.id AS order_id, o.folio AS order_folio, o.status AS order_status,
              o.total AS order_total, o.created_at AS order_created_at
         FROM restaurant_tables t
         LEFT JOIN orders o ON o.table_id = t.id AND o.restaurant_id = t.restaurant_id
                           AND o.status IN ('abierta', 'enviada', 'lista')
        WHERE t.restaurant_id = $1 AND t.branch_id = $2
        ORDER BY t.sort_order, t.name`,
      [req.tenant.id, branchId],
    )).rows;
    return { zones, tables };
  });
  res.json(data);
}));

// ---------------------------------------------------------------------------
// Zonas
// ---------------------------------------------------------------------------

router.post('/zones', requireRole(...ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const f = {
    branch_id: branchId,
    name: str(body.name, { field: 'name', required: true, max: 60 }),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
  const zone = await withTenant(req.tenant.id, async (db) => {
    await assertBranchExists(db, req.tenant.id, branchId);
    const q = insertSql('restaurant_zones', req.tenant.id, f, ZONE_COLS);
    return (await db.query(q.text, q.values)).rows[0];
  });
  res.status(201).json({ zone });
}));

router.patch('/zones/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const f = {
    name: str(body.name, { field: 'name', max: 60 }),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  const set = buildSet(f, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const zone = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE restaurant_zones SET ${set.sql}, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${ZONE_COLS}`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]);
  if (!zone) throw notFound('Zona no encontrada', 'ZONE_NOT_FOUND');
  res.json({ zone });
}));

// Borrar una zona deja sus mesas sin zona.
router.delete('/zones/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    await db.query(
      'UPDATE restaurant_tables SET zone_id = NULL, updated_at = now() WHERE zone_id = $1 AND restaurant_id = $2',
      [req.params.id, req.tenant.id],
    );
    const { rowCount } = await db.query('DELETE FROM restaurant_zones WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Zona no encontrada', 'ZONE_NOT_FOUND');
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Mesas
// ---------------------------------------------------------------------------

function tableFields(body, creating) {
  const f = {
    zone_id: body.zone_id === undefined ? undefined : (body.zone_id ? requireUuid(body.zone_id, 'zone_id') : null),
    name: str(body.name, { field: 'name', required: creating, max: 30 }),
    capacity: int(body.capacity, { field: 'capacity', min: 1, max: 100 }),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  return f;
}

router.post('/tables', requireRole(...ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const f = { branch_id: branchId, ...tableFields(body, true) };
  const table = await withTenant(req.tenant.id, async (db) => {
    await assertBranchExists(db, req.tenant.id, branchId);
    // La FK (restaurant_id, branch_id, zone_id) impide usar una zona de otra sucursal.
    const q = insertSql('restaurant_tables', req.tenant.id, f, TABLE_COLS);
    return (await db.query(q.text, q.values)).rows[0];
  });
  res.status(201).json({ table });
}));

router.patch('/tables/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const set = buildSet(tableFields(req.body || {}, false), 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const table = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE restaurant_tables SET ${set.sql}, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${TABLE_COLS}`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]);
  if (!table) throw notFound('Mesa no encontrada', 'TABLE_NOT_FOUND');
  res.json({ table });
}));

// Una mesa con ordenes en su historial no se borra: se desactiva.
router.delete('/tables/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await withTenant(req.tenant.id, async (db) => {
    const used = await db.query(
      'SELECT status FROM orders WHERE table_id = $1 AND restaurant_id = $2',
      [req.params.id, req.tenant.id],
    );
    if (used.rows.some((o) => ['abierta', 'enviada', 'lista'].includes(o.status))) {
      throw badRequest('La mesa tiene una orden activa', 'TABLE_OCCUPIED');
    }
    if (used.rowCount) {
      const { rowCount } = await db.query(
        'UPDATE restaurant_tables SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.tenant.id],
      );
      if (!rowCount) throw notFound('Mesa no encontrada', 'TABLE_NOT_FOUND');
      return { archived: true };
    }
    const { rowCount } = await db.query('DELETE FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Mesa no encontrada', 'TABLE_NOT_FOUND');
    return null;
  });
  if (result) return res.json(result);
  res.status(204).end();
}));

export default router;
