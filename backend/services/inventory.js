// Existencias del modulo de inventario: cada cambio pasa por applyMovement,
// que actualiza inv_stock y deja el renglon en el kardex (inv_movements).
// Tambien calcula el consumo por receta de una orden y lo descuenta al cobrar.
import { badRequest } from '../utils/http.js';

export const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

/** Suma (o resta) quantity a la existencia de la sucursal y la registra. Regresa la existencia nueva. */
export async function applyMovement(db, restaurantId, {
  branchId, productId, kind, quantity, unitCost = null, reason = null,
  orderId = null, countId = null, purchaseOrderId = null, userId = null, setTo = null,
}) {
  // setTo: la existencia queda exactamente en ese valor (conteo).
  const { rows } = await db.query(
    `INSERT INTO inv_stock (restaurant_id, branch_id, product_id, quantity, last_count_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
     ON CONFLICT (branch_id, product_id) DO UPDATE
       SET quantity = CASE WHEN $5 THEN EXCLUDED.quantity ELSE inv_stock.quantity + EXCLUDED.quantity END,
           last_count_at = CASE WHEN $5 THEN now() ELSE inv_stock.last_count_at END,
           updated_at = now()
     RETURNING quantity, (SELECT quantity FROM inv_stock s WHERE s.branch_id = $2 AND s.product_id = $3) AS before`,
    [restaurantId, branchId, productId, setTo !== null ? round4(setTo) : round4(quantity), setTo !== null],
  );
  const balance = Number(rows[0].quantity);
  const before = rows[0].before === null ? 0 : Number(rows[0].before);
  const delta = setTo !== null ? round4(balance - before) : round4(quantity);
  if (delta === 0 && kind !== 'conteo') return balance;
  await db.query(
    `INSERT INTO inv_movements (restaurant_id, branch_id, product_id, kind, quantity, balance, unit_cost, reason,
                                order_id, count_id, purchase_order_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [restaurantId, branchId, productId, kind, delta, balance, unitCost, reason, orderId, countId, purchaseOrderId, userId],
  );
  return balance;
}

/**
 * Insumos que consume una lista de articulos vendidos segun las recetas.
 * items: [{ menu_item_id, quantity, modifier_ids: [] }]. Regresa Map(product_id -> cantidad base).
 * Por cada modificador se usa su receta para ese producto si existe; si no, la general.
 */
export async function consumptionFor(db, restaurantId, items) {
  const menuIds = [...new Set(items.map((i) => i.menu_item_id))];
  const modIds = [...new Set(items.flatMap((i) => i.modifier_ids || []))];
  const recipes = (await db.query(
    'SELECT menu_item_id, product_id, quantity FROM inv_recipe_items WHERE restaurant_id = $1 AND menu_item_id = ANY($2::uuid[])',
    [restaurantId, menuIds],
  )).rows;
  const modRecipes = modIds.length ? (await db.query(
    `SELECT modifier_id, menu_item_id, product_id, quantity FROM inv_modifier_recipe_items
      WHERE restaurant_id = $1 AND modifier_id = ANY($2::uuid[])`,
    [restaurantId, modIds],
  )).rows : [];

  const out = new Map();
  const add = (productId, qty) => out.set(productId, round4((out.get(productId) || 0) + qty));
  for (const it of items) {
    const units = Number(it.quantity);
    for (const r of recipes) if (r.menu_item_id === it.menu_item_id) add(r.product_id, Number(r.quantity) * units);
    for (const modId of it.modifier_ids || []) {
      const specific = modRecipes.filter((r) => r.modifier_id === modId && r.menu_item_id === it.menu_item_id);
      const rows = specific.length ? specific : modRecipes.filter((r) => r.modifier_id === modId && !r.menu_item_id);
      for (const r of rows) add(r.product_id, Number(r.quantity) * units);
    }
  }
  return out;
}

async function inventoryActive(db, restaurantId) {
  const { rows } = await db.query(
    `SELECT coalesce(s.deduct_on_sale, true) AS deduct
       FROM restaurant_modules rm
       LEFT JOIN inv_settings s ON s.restaurant_id = rm.restaurant_id
      WHERE rm.restaurant_id = $1 AND rm.module_code = 'inventario' AND rm.enabled
        AND (rm.ends_at IS NULL OR rm.ends_at > now())`,
    [restaurantId],
  );
  return Boolean(rows[0]?.deduct);
}

/**
 * Descuenta del inventario lo que consumio una orden pagada (por receta).
 * Solo si el restaurante tiene el modulo y el descuento automatico activo.
 * Idempotente: una orden se descuenta una sola vez.
 */
export async function deductOrder(db, restaurantId, orderId, userId = null) {
  if (!(await inventoryActive(db, restaurantId))) return 0;
  const done = await db.query(
    "SELECT 1 FROM inv_movements WHERE restaurant_id = $1 AND order_id = $2 AND kind = 'venta' LIMIT 1",
    [restaurantId, orderId],
  );
  if (done.rowCount) return 0;
  const order = (await db.query('SELECT branch_id, folio FROM orders WHERE id = $1 AND restaurant_id = $2', [orderId, restaurantId])).rows[0];
  if (!order) return 0;
  const items = (await db.query(
    `SELECT i.menu_item_id, i.quantity,
            coalesce(array_agg(m.modifier_id) FILTER (WHERE m.modifier_id IS NOT NULL), '{}') AS modifier_ids
       FROM order_items i
       LEFT JOIN order_item_modifiers m ON m.order_item_id = i.id AND m.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.order_id = $2 AND i.voided_at IS NULL
      GROUP BY i.id`,
    [restaurantId, orderId],
  )).rows;
  const use = await consumptionFor(db, restaurantId, items);
  const costs = new Map((await db.query(
    'SELECT id, unit_cost FROM inv_products WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
    [restaurantId, [...use.keys()]],
  )).rows.map((p) => [p.id, p.unit_cost]));
  for (const [productId, qty] of use) {
    await applyMovement(db, restaurantId, {
      branchId: order.branch_id, productId, kind: 'venta', quantity: -qty, unitCost: costs.get(productId) ?? null,
      reason: `Orden #${order.folio}`, orderId, userId,
    });
  }
  return use.size;
}

/** Convierte una cantidad capturada en una unidad del insumo a su unidad base. */
export async function toBase(db, restaurantId, productId, quantity, unitName) {
  const p = (await db.query('SELECT base_unit FROM inv_products WHERE id = $1 AND restaurant_id = $2', [productId, restaurantId])).rows[0];
  if (!p) throw badRequest('Insumo no encontrado', 'PRODUCT_NOT_FOUND');
  if (!unitName || unitName === p.base_unit) return { quantity: round4(quantity), unit: p.base_unit, factor: 1 };
  const u = (await db.query(
    'SELECT factor FROM inv_product_units WHERE restaurant_id = $1 AND product_id = $2 AND name = $3',
    [restaurantId, productId, unitName],
  )).rows[0];
  if (!u) throw badRequest(`La unidad "${unitName}" no existe para este insumo`, 'UNIT_NOT_FOUND');
  return { quantity: round4(Number(quantity) * Number(u.factor)), unit: unitName, factor: Number(u.factor) };
}
