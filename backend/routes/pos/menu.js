// Menu del POS: categorias, productos (con disponibilidad por sucursal) y
// grupos de modificadores. Escritura: admin y gerente.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { ah, badRequest, bool, buildSet, money, notFound, requireUuid, str } from '../../utils/http.js';
import {
  ROLES, assertBranchExists, imageUrl, insertSql, int, isManager, requireBranch, signedMoney, uuidList,
} from './common.js';

const router = Router();

const CATEGORY_COLS = 'id, name, description, sort_order, active';
const ITEM_COLS = 'id, category_id, name, description, price, image_url, active, sort_order';
const GROUP_COLS = 'id, name, min_selections, max_selections, sort_order, active';
const MODIFIER_COLS = 'id, group_id, name, price_delta, sort_order, active';

/**
 * Menu completo. Con ?branch_id= marca `available` segun esa sucursal.
 * Los inactivos solo se incluyen para admin/gerente con ?all=1.
 */
export async function loadMenu(db, restaurantId, { branchId = null, includeInactive = false } = {}) {
  const onlyActive = includeInactive ? '' : 'AND active';
  const categories = (await db.query(
    `SELECT ${CATEGORY_COLS} FROM menu_categories WHERE restaurant_id = $1 ${onlyActive} ORDER BY sort_order, name`,
    [restaurantId],
  )).rows;
  const items = (await db.query(
    `SELECT ${ITEM_COLS.split(', ').map((c) => `i.${c}`).join(', ')},
            coalesce((SELECT array_agg(g.modifier_group_id ORDER BY g.sort_order)
                        FROM menu_item_modifier_groups g WHERE g.menu_item_id = i.id), '{}') AS modifier_group_ids,
            coalesce((SELECT array_agg(b.branch_id) FROM menu_item_branches b
                       WHERE b.menu_item_id = i.id AND NOT b.available), '{}') AS unavailable_branch_ids
       FROM menu_items i
      WHERE i.restaurant_id = $1 ${includeInactive ? '' : 'AND i.active'}
      ORDER BY i.sort_order, i.name`,
    [restaurantId],
  )).rows.map((it) => ({
    ...it,
    available: branchId ? !it.unavailable_branch_ids.includes(branchId) : true,
  }));
  const groups = (await db.query(
    `SELECT ${GROUP_COLS} FROM modifier_groups WHERE restaurant_id = $1 ${onlyActive} ORDER BY sort_order, name`,
    [restaurantId],
  )).rows;
  const modifiers = (await db.query(
    `SELECT ${MODIFIER_COLS} FROM modifiers WHERE restaurant_id = $1 ${onlyActive} ORDER BY sort_order, name`,
    [restaurantId],
  )).rows;
  for (const g of groups) g.modifiers = modifiers.filter((m) => m.group_id === g.id);
  return { categories, items, modifier_groups: groups };
}

router.get('/menu', requireRole(...ROLES.kitchen), ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireBranch(req, req.query.branch_id) : null;
  const includeInactive = req.query.all === '1' && isManager(req.user);
  const menu = await withTenant(req.tenant.id, (db) => loadMenu(db, req.tenant.id, { branchId, includeInactive }));
  res.json(menu);
}));

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

function categoryFields(body, creating) {
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 80 }),
    description: str(body.description, { field: 'description', max: 300 }),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  return f;
}

router.post('/categories', requireRole(...ROLES.manage), ah(async (req, res) => {
  const q = insertSql('menu_categories', req.tenant.id, categoryFields(req.body || {}, true), CATEGORY_COLS);
  const row = await withTenant(req.tenant.id, async (db) => (await db.query(q.text, q.values)).rows[0]);
  res.status(201).json({ category: row });
}));

router.patch('/categories/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const set = buildSet(categoryFields(req.body || {}, false), 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const row = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE menu_categories SET ${set.sql}, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${CATEGORY_COLS}`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]);
  if (!row) throw notFound('Categoria no encontrada', 'CATEGORY_NOT_FOUND');
  res.json({ category: row });
}));

router.delete('/categories/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const items = await db.query(
      'SELECT count(*)::int AS n FROM menu_items WHERE category_id = $1 AND restaurant_id = $2',
      [req.params.id, req.tenant.id],
    );
    if (items.rows[0].n > 0) {
      throw badRequest('La categoria tiene productos: muevelos o borralos primero', 'CATEGORY_NOT_EMPTY');
    }
    const { rowCount } = await db.query(
      'DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, req.tenant.id],
    );
    if (!rowCount) throw notFound('Categoria no encontrada', 'CATEGORY_NOT_FOUND');
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

function itemFields(body, creating) {
  const f = {
    category_id: body.category_id === undefined ? undefined : requireUuid(body.category_id, 'category_id'),
    name: str(body.name, { field: 'name', required: creating, max: 120 }),
    description: str(body.description, { field: 'description', max: 500 }),
    price: money(body.price, { field: 'price' }),
    image_url: imageUrl(body.image_url),
    active: bool(body.active, 'active'),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
  };
  if (creating && !f.category_id) throw badRequest('La categoria es obligatoria', 'MISSING_FIELD');
  if (creating && f.price === undefined) throw badRequest('El precio es obligatorio', 'MISSING_FIELD');
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  return f;
}

/** Reemplaza los grupos de modificadores de un producto (en el orden dado). */
async function setItemGroups(db, restaurantId, itemId, groupIds) {
  if (groupIds.length) {
    const valid = await db.query(
      'SELECT id FROM modifier_groups WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
      [restaurantId, groupIds],
    );
    if (valid.rowCount !== groupIds.length) throw badRequest('Algun grupo de modificadores no existe', 'GROUP_NOT_FOUND');
  }
  await db.query('DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND restaurant_id = $2', [itemId, restaurantId]);
  for (const [i, gid] of groupIds.entries()) {
    await db.query(
      `INSERT INTO menu_item_modifier_groups (restaurant_id, menu_item_id, modifier_group_id, sort_order)
       VALUES ($1, $2, $3, $4)`,
      [restaurantId, itemId, gid, i],
    );
  }
}

/** Marca como no disponible el producto en las sucursales dadas (y disponible en las demas). */
async function setUnavailableBranches(db, restaurantId, itemId, branchIds) {
  if (branchIds.length) {
    const valid = await db.query(
      'SELECT id FROM branches WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
      [restaurantId, branchIds],
    );
    if (valid.rowCount !== branchIds.length) throw badRequest('Alguna sucursal no existe', 'BRANCH_NOT_FOUND');
  }
  await db.query('DELETE FROM menu_item_branches WHERE menu_item_id = $1 AND restaurant_id = $2', [itemId, restaurantId]);
  for (const bid of branchIds) {
    await db.query(
      `INSERT INTO menu_item_branches (restaurant_id, menu_item_id, branch_id, available) VALUES ($1, $2, $3, false)`,
      [restaurantId, itemId, bid],
    );
  }
}

async function getItem(db, restaurantId, id) {
  const menu = await db.query(
    `SELECT ${ITEM_COLS},
            coalesce((SELECT array_agg(g.modifier_group_id ORDER BY g.sort_order)
                        FROM menu_item_modifier_groups g WHERE g.menu_item_id = i.id), '{}') AS modifier_group_ids,
            coalesce((SELECT array_agg(b.branch_id) FROM menu_item_branches b
                       WHERE b.menu_item_id = i.id AND NOT b.available), '{}') AS unavailable_branch_ids
       FROM menu_items i WHERE id = $1 AND restaurant_id = $2`,
    [id, restaurantId],
  );
  return menu.rows[0] || null;
}

router.post('/items', requireRole(...ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const f = itemFields(body, true);
  const groupIds = uuidList(body.modifier_group_ids, 'modifier_group_ids') || [];
  const unavailable = uuidList(body.unavailable_branch_ids, 'unavailable_branch_ids') || [];
  const item = await withTenant(req.tenant.id, async (db) => {
    const q = insertSql('menu_items', req.tenant.id, f, 'id');
    const { rows } = await db.query(q.text, q.values);
    await setItemGroups(db, req.tenant.id, rows[0].id, groupIds);
    await setUnavailableBranches(db, req.tenant.id, rows[0].id, unavailable);
    return getItem(db, req.tenant.id, rows[0].id);
  });
  res.status(201).json({ item });
}));

router.patch('/items/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const set = buildSet(itemFields(body, false), 3);
  const groupIds = uuidList(body.modifier_group_ids, 'modifier_group_ids');
  const unavailable = uuidList(body.unavailable_branch_ids, 'unavailable_branch_ids');
  if (!set && !groupIds && !unavailable) throw badRequest('No hay cambios', 'NO_CHANGES');
  const item = await withTenant(req.tenant.id, async (db) => {
    if (!(await getItem(db, req.tenant.id, req.params.id))) throw notFound('Producto no encontrado', 'ITEM_NOT_FOUND');
    if (set) {
      await db.query(
        `UPDATE menu_items SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.tenant.id, ...set.values],
      );
    }
    if (groupIds) await setItemGroups(db, req.tenant.id, req.params.id, groupIds);
    if (unavailable) await setUnavailableBranches(db, req.tenant.id, req.params.id, unavailable);
    return getItem(db, req.tenant.id, req.params.id);
  });
  res.json({ item });
}));

// Agotado / disponible en una sucursal (cajero tambien puede).
router.put('/items/:id/availability', requireRole(...ROLES.availability), ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const available = bool(body.available, 'available');
  if (available === undefined) throw badRequest('El campo "available" es obligatorio', 'MISSING_FIELD');
  await withTenant(req.tenant.id, async (db) => {
    if (!(await getItem(db, req.tenant.id, req.params.id))) throw notFound('Producto no encontrado', 'ITEM_NOT_FOUND');
    await assertBranchExists(db, req.tenant.id, branchId);
    await db.query(
      `INSERT INTO menu_item_branches (restaurant_id, menu_item_id, branch_id, available)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (menu_item_id, branch_id) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
      [req.tenant.id, req.params.id, branchId, available],
    );
  });
  res.json({ ok: true, available });
}));

// Si el producto ya se vendio no se puede borrar (las ventas lo referencian):
// se desactiva y se responde archived = true.
router.delete('/items/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await withTenant(req.tenant.id, async (db) => {
    const sold = await db.query(
      'SELECT 1 FROM order_items WHERE menu_item_id = $1 AND restaurant_id = $2 LIMIT 1',
      [req.params.id, req.tenant.id],
    );
    if (sold.rowCount) {
      const { rowCount } = await db.query(
        'UPDATE menu_items SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.tenant.id],
      );
      if (!rowCount) throw notFound('Producto no encontrado', 'ITEM_NOT_FOUND');
      return { archived: true };
    }
    const { rowCount } = await db.query('DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Producto no encontrado', 'ITEM_NOT_FOUND');
    return null;
  });
  if (result) return res.json(result);
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Grupos de modificadores (con sus opciones)
// ---------------------------------------------------------------------------

function groupFields(body, creating) {
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 80 }),
    min_selections: int(body.min_selections, { field: 'min_selections', max: 50 }),
    max_selections: int(body.max_selections, { field: 'max_selections', min: 1, max: 50, nullable: true }),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  if (f.min_selections !== undefined && f.max_selections !== undefined && f.max_selections !== null
      && f.max_selections < f.min_selections) {
    throw badRequest('El maximo de opciones no puede ser menor que el minimo', 'INVALID_FIELD');
  }
  return f;
}

function readModifiers(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest('modifiers debe ser una lista', 'INVALID_FIELD');
  return value.map((m, i) => ({
    id: m.id ? requireUuid(m.id, 'modifiers.id') : null,
    name: str(m.name, { field: 'modifiers.name', required: true, max: 80 }),
    price_delta: signedMoney(m.price_delta ?? 0, { field: 'modifiers.price_delta' }),
    active: bool(m.active, 'modifiers.active') ?? true,
    sort_order: i,
  }));
}

/** Sincroniza las opciones: actualiza las que traen id, crea las nuevas y borra las que faltan. */
async function syncModifiers(db, restaurantId, groupId, modifiers) {
  const keep = modifiers.filter((m) => m.id).map((m) => m.id);
  await db.query(
    'DELETE FROM modifiers WHERE group_id = $1 AND restaurant_id = $2 AND NOT (id = ANY($3::uuid[]))',
    [groupId, restaurantId, keep],
  );
  for (const m of modifiers) {
    if (m.id) {
      const { rowCount } = await db.query(
        `UPDATE modifiers SET name = $4, price_delta = $5, active = $6, sort_order = $7, updated_at = now()
          WHERE id = $1 AND group_id = $2 AND restaurant_id = $3`,
        [m.id, groupId, restaurantId, m.name, m.price_delta, m.active, m.sort_order],
      );
      if (!rowCount) throw badRequest('Alguna opcion no pertenece a este grupo', 'MODIFIER_NOT_FOUND');
    } else {
      await db.query(
        `INSERT INTO modifiers (restaurant_id, group_id, name, price_delta, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [restaurantId, groupId, m.name, m.price_delta, m.active, m.sort_order],
      );
    }
  }
}

async function getGroup(db, restaurantId, id) {
  const { rows } = await db.query(`SELECT ${GROUP_COLS} FROM modifier_groups WHERE id = $1 AND restaurant_id = $2`, [id, restaurantId]);
  if (!rows[0]) return null;
  rows[0].modifiers = (await db.query(
    `SELECT ${MODIFIER_COLS} FROM modifiers WHERE group_id = $1 AND restaurant_id = $2 ORDER BY sort_order, name`,
    [id, restaurantId],
  )).rows;
  return rows[0];
}

router.post('/modifier-groups', requireRole(...ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const f = groupFields(body, true);
  const modifiers = readModifiers(body.modifiers) || [];
  const group = await withTenant(req.tenant.id, async (db) => {
    const q = insertSql('modifier_groups', req.tenant.id, f, 'id');
    const { rows } = await db.query(q.text, q.values);
    await syncModifiers(db, req.tenant.id, rows[0].id, modifiers.map((m) => ({ ...m, id: null })));
    return getGroup(db, req.tenant.id, rows[0].id);
  });
  res.status(201).json({ group });
}));

router.patch('/modifier-groups/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const set = buildSet(groupFields(body, false), 3);
  const modifiers = readModifiers(body.modifiers);
  if (!set && !modifiers) throw badRequest('No hay cambios', 'NO_CHANGES');
  const group = await withTenant(req.tenant.id, async (db) => {
    if (!(await getGroup(db, req.tenant.id, req.params.id))) throw notFound('Grupo no encontrado', 'GROUP_NOT_FOUND');
    if (set) {
      await db.query(
        `UPDATE modifier_groups SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.tenant.id, ...set.values],
      );
    }
    if (modifiers) await syncModifiers(db, req.tenant.id, req.params.id, modifiers);
    return getGroup(db, req.tenant.id, req.params.id);
  });
  res.json({ group });
}));

router.delete('/modifier-groups/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const deleted = await withTenant(req.tenant.id, async (db) => (await db.query(
    'DELETE FROM modifier_groups WHERE id = $1 AND restaurant_id = $2',
    [req.params.id, req.tenant.id],
  )).rowCount);
  if (!deleted) throw notFound('Grupo no encontrado', 'GROUP_NOT_FOUND');
  res.status(204).end();
}));

export default router;
