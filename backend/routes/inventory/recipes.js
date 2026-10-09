// Recetas: insumos por producto del menu y por modificador (general o solo
// para un producto). Con el costo de cada insumo se calcula el costo de la
// receta y su porcentaje sobre el precio de venta.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { toBase } from '../../services/inventory.js';
import { ah, badRequest, notFound, requireUuid } from '../../utils/http.js';
import { INV_ROLES, qty } from './common.js';

const router = Router();
const manage = requireRole(...INV_ROLES.manage);
const round2 = (n) => Math.round(n * 100) / 100;

// Lista del menu con el costo de su receta (sin modificadores).
router.get('/recipes', manage, ah(async (req, res) => {
  const items = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT i.id, i.name, i.price, c.name AS category,
            count(r.id)::int AS ingredients,
            coalesce(sum(r.quantity * p.unit_cost), 0) AS cost
       FROM menu_items i
       JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
       LEFT JOIN inv_recipe_items r ON r.menu_item_id = i.id AND r.restaurant_id = i.restaurant_id
       LEFT JOIN inv_products p ON p.id = r.product_id AND p.restaurant_id = r.restaurant_id
      WHERE i.restaurant_id = $1 AND i.active
      GROUP BY i.id, c.name, c.sort_order
      ORDER BY c.sort_order, i.sort_order, i.name`,
    [req.tenant.id],
  )).rows.map((r) => {
    const cost = round2(Number(r.cost));
    return { ...r, cost, cost_pct: Number(r.price) > 0 ? round2((cost / Number(r.price)) * 100) : null };
  }));
  res.json({ items });
}));

async function recipeOf(db, rid, menuItemId) {
  const item = (await db.query('SELECT id, name, price FROM menu_items WHERE id = $1 AND restaurant_id = $2', [menuItemId, rid])).rows[0];
  if (!item) throw notFound('Producto no encontrado', 'MENU_ITEM_NOT_FOUND');
  const lines = (await db.query(
    `SELECT r.product_id, p.name, p.base_unit, r.quantity, p.unit_cost
       FROM inv_recipe_items r JOIN inv_products p ON p.id = r.product_id AND p.restaurant_id = r.restaurant_id
      WHERE r.restaurant_id = $1 AND r.menu_item_id = $2 ORDER BY p.name`,
    [rid, menuItemId],
  )).rows;
  // Modificadores de los grupos del producto, con su receta para este
  // producto (specific) y la general.
  const modifiers = (await db.query(
    `SELECT m.id, m.name, g.name AS group_name, m.price_delta
       FROM menu_item_modifier_groups mg
       JOIN modifier_groups g ON g.id = mg.modifier_group_id AND g.restaurant_id = mg.restaurant_id
       JOIN modifiers m ON m.group_id = g.id AND m.restaurant_id = g.restaurant_id AND m.active
      WHERE mg.restaurant_id = $1 AND mg.menu_item_id = $2
      ORDER BY mg.sort_order, m.sort_order, m.name`,
    [rid, menuItemId],
  )).rows;
  const modLines = modifiers.length ? (await db.query(
    `SELECT r.modifier_id, r.menu_item_id, r.product_id, p.name, p.base_unit, r.quantity, p.unit_cost
       FROM inv_modifier_recipe_items r JOIN inv_products p ON p.id = r.product_id AND p.restaurant_id = r.restaurant_id
      WHERE r.restaurant_id = $1 AND r.modifier_id = ANY($2::uuid[]) AND (r.menu_item_id IS NULL OR r.menu_item_id = $3)`,
    [rid, modifiers.map((m) => m.id), menuItemId],
  )).rows : [];
  const cost = (ls) => round2(ls.reduce((a, l) => a + Number(l.quantity) * Number(l.unit_cost), 0));
  for (const m of modifiers) {
    m.general = modLines.filter((l) => l.modifier_id === m.id && !l.menu_item_id);
    m.specific = modLines.filter((l) => l.modifier_id === m.id && l.menu_item_id === menuItemId);
    m.cost = cost(m.specific.length ? m.specific : m.general);
  }
  const total = cost(lines);
  return {
    item: { ...item, cost: total, cost_pct: Number(item.price) > 0 ? round2((total / Number(item.price)) * 100) : null },
    lines,
    modifiers,
  };
}

router.get('/recipes/:menuItemId', manage, ah(async (req, res) => {
  requireUuid(req.params.menuItemId);
  res.json(await withTenant(req.tenant.id, (db) => recipeOf(db, req.tenant.id, req.params.menuItemId)));
}));

/** [{ product_id, quantity, unit }] -> [{ product_id, quantity (base) }]. */
async function parseLines(db, rid, list) {
  if (!Array.isArray(list) || list.length > 100) throw badRequest('items debe ser una lista (maximo 100)', 'INVALID_FIELD');
  const out = new Map();
  for (const l of list) {
    requireUuid(l?.product_id, 'product_id');
    const q = qty(l.quantity, { field: 'quantity', positive: true });
    const base = await toBase(db, rid, l.product_id, q, l.unit);
    out.set(l.product_id, (out.get(l.product_id) || 0) + base.quantity);
  }
  return [...out].map(([productId, quantity]) => ({ productId, quantity }));
}

router.put('/recipes/:menuItemId', manage, ah(async (req, res) => {
  requireUuid(req.params.menuItemId);
  const data = await withTenant(req.tenant.id, async (db) => {
    const rid = req.tenant.id;
    await recipeOf(db, rid, req.params.menuItemId);
    const lines = await parseLines(db, rid, req.body?.items);
    await db.query('DELETE FROM inv_recipe_items WHERE restaurant_id = $1 AND menu_item_id = $2', [rid, req.params.menuItemId]);
    for (const l of lines) {
      await db.query('INSERT INTO inv_recipe_items (restaurant_id, menu_item_id, product_id, quantity) VALUES ($1, $2, $3, $4)',
        [rid, req.params.menuItemId, l.productId, l.quantity]);
    }
    return recipeOf(db, rid, req.params.menuItemId);
  });
  res.json(data);
}));

// Receta de un modificador. menu_item_id: solo para ese producto (sustituye
// a la general); sin el, la general. items vacio la borra.
router.put('/modifier-recipes/:modifierId', manage, ah(async (req, res) => {
  requireUuid(req.params.modifierId);
  const menuItemId = req.body?.menu_item_id ? requireUuid(req.body.menu_item_id, 'menu_item_id') : null;
  const data = await withTenant(req.tenant.id, async (db) => {
    const rid = req.tenant.id;
    const m = await db.query('SELECT 1 FROM modifiers WHERE id = $1 AND restaurant_id = $2', [req.params.modifierId, rid]);
    if (!m.rowCount) throw notFound('Modificador no encontrado', 'MODIFIER_NOT_FOUND');
    if (menuItemId) await recipeOf(db, rid, menuItemId);
    const lines = await parseLines(db, rid, req.body?.items);
    await db.query(
      `DELETE FROM inv_modifier_recipe_items WHERE restaurant_id = $1 AND modifier_id = $2
          AND menu_item_id IS NOT DISTINCT FROM $3::uuid`,
      [rid, req.params.modifierId, menuItemId],
    );
    for (const l of lines) {
      await db.query(
        'INSERT INTO inv_modifier_recipe_items (restaurant_id, modifier_id, menu_item_id, product_id, quantity) VALUES ($1, $2, $3, $4, $5)',
        [rid, req.params.modifierId, menuItemId, l.productId, l.quantity],
      );
    }
    return menuItemId ? recipeOf(db, rid, menuItemId) : { ok: true };
  });
  res.json(data);
}));

export default router;
