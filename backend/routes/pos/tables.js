// Zonas y mesas por sucursal. Una mesa esta "ocupada" si tiene una orden
// activa (abierta, enviada o lista); no se guarda un estado aparte.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { ah, badRequest, bool, buildSet, notFound, requireUuid, str } from '../../utils/http.js';
import { ROLES, assertBranchExists, insertSql, int, requireBranch } from './common.js';
import { can } from '../../services/permissions.js';

const router = Router();

const ZONE_COLS = 'id, branch_id, name, sort_order, active, map_enabled, map_width, map_height';
const TABLE_COLS = 'id, branch_id, zone_id, name, capacity, sort_order, active';
// Plano: posicion, tamano y forma de la mesa.
const MAP_COLS = 'map_x, map_y, map_w, map_h, map_shape';

router.get('/tables', can('orders'), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const zones = (await db.query(
      `SELECT ${ZONE_COLS} FROM restaurant_zones WHERE restaurant_id = $1 AND branch_id = $2
        ORDER BY sort_order, name`,
      [req.tenant.id, branchId],
    )).rows;
    const tables = (await db.query(
      `SELECT ${[...TABLE_COLS.split(', '), ...MAP_COLS.split(', ')].map((c) => `t.${c}`).join(', ')},
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
    const objects = (await db.query(
      'SELECT id, zone_id, kind, label, x, y, w, h FROM zone_map_objects WHERE restaurant_id = $1 AND branch_id = $2',
      [req.tenant.id, branchId],
    )).rows;
    return { zones, tables, objects };
  });
  res.json(data);
}));

// Guardar el plano de una zona: { map_enabled, map_width, map_height,
// tables: [{ id, map_x, map_y, map_w, map_h, map_shape }], objects: [{ kind, label, x, y, w, h }] }.
// Los elementos se reemplazan; las mesas que no vienen quedan como estaban.
const OBJECT_KINDS = ['barra', 'pared', 'puerta', 'bano', 'caja', 'cocina', 'planta', 'texto'];
router.put('/zones/:id/map', can('manage'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const b = req.body || {};
  const width = int(b.map_width ?? 24, { field: 'map_width', min: 8, max: 60 });
  const height = int(b.map_height ?? 16, { field: 'map_height', min: 6, max: 60 });
  const inside = (x, y, w, h, what) => {
    if (x + w > width || y + h > height) throw badRequest(`${what} se sale del plano`, 'OUT_OF_MAP');
  };
  const tables = (Array.isArray(b.tables) ? b.tables : []).slice(0, 300).map((t) => {
    const placed = t.map_x !== null && t.map_x !== undefined;
    const r = {
      id: requireUuid(t.id, 'table id'),
      map_x: placed ? int(t.map_x, { field: 'map_x', min: 0, max: 59 }) : null,
      map_y: placed ? int(t.map_y, { field: 'map_y', min: 0, max: 59 }) : null,
      map_w: int(t.map_w ?? 2, { field: 'map_w', min: 1, max: 12 }),
      map_h: int(t.map_h ?? 2, { field: 'map_h', min: 1, max: 12 }),
      map_shape: t.map_shape === 'redonda' ? 'redonda' : 'cuadrada',
    };
    if (placed) inside(r.map_x, r.map_y, r.map_w, r.map_h, 'Una mesa');
    return r;
  });
  const objects = (Array.isArray(b.objects) ? b.objects : []).slice(0, 200).map((o) => {
    if (!OBJECT_KINDS.includes(o?.kind)) throw badRequest('Elemento desconocido', 'INVALID_FIELD');
    const r = {
      kind: o.kind, label: str(o.label, { field: 'label', max: 40 }) || null,
      x: int(o.x, { field: 'x', min: 0, max: 59 }), y: int(o.y, { field: 'y', min: 0, max: 59 }),
      w: int(o.w ?? 2, { field: 'w', min: 1, max: 60 }), h: int(o.h ?? 1, { field: 'h', min: 1, max: 60 }),
    };
    inside(r.x, r.y, r.w, r.h, 'Un elemento');
    return r;
  });
  const zone = await withTenant(req.tenant.id, async (db) => {
    const z = (await db.query('SELECT id, branch_id FROM restaurant_zones WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id])).rows[0];
    if (!z) throw notFound('Zona no encontrada', 'ZONE_NOT_FOUND');
    requireBranch(req, z.branch_id);
    await db.query(
      'UPDATE restaurant_zones SET map_enabled = $3, map_width = $4, map_height = $5, updated_at = now() WHERE id = $1 AND restaurant_id = $2',
      [z.id, req.tenant.id, b.map_enabled !== false, width, height],
    );
    for (const t of tables) {
      const { rowCount } = await db.query(
        `UPDATE restaurant_tables SET map_x = $4, map_y = $5, map_w = $6, map_h = $7, map_shape = $8, updated_at = now()
          WHERE id = $1 AND restaurant_id = $2 AND zone_id = $3`,
        [t.id, req.tenant.id, z.id, t.map_x, t.map_y, t.map_w, t.map_h, t.map_shape],
      );
      if (!rowCount) throw badRequest('Esa mesa no es de esta zona', 'TABLE_NOT_IN_ZONE');
    }
    await db.query('DELETE FROM zone_map_objects WHERE zone_id = $1 AND restaurant_id = $2', [z.id, req.tenant.id]);
    for (const o of objects) {
      await db.query(
        'INSERT INTO zone_map_objects (restaurant_id, branch_id, zone_id, kind, label, x, y, w, h) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [req.tenant.id, z.branch_id, z.id, o.kind, o.label, o.x, o.y, o.w, o.h],
      );
    }
    return (await db.query(`SELECT ${ZONE_COLS} FROM restaurant_zones WHERE id = $1`, [z.id])).rows[0];
  });
  res.json({ zone });
}));

// ---------------------------------------------------------------------------
// Zonas
// ---------------------------------------------------------------------------

router.post('/zones', can('manage'), ah(async (req, res) => {
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

router.patch('/zones/:id', can('manage'), ah(async (req, res) => {
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
router.delete('/zones/:id', can('manage'), ah(async (req, res) => {
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

router.post('/tables', can('manage'), ah(async (req, res) => {
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

router.patch('/tables/:id', can('manage'), ah(async (req, res) => {
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
router.delete('/tables/:id', can('manage'), ah(async (req, res) => {
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
