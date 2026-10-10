// Ventas por evento (modulo "eventos"): pedidos con cupo por producto.
import crypto from 'node:crypto';
import { HttpError, badRequest, requireUuid, str } from '../utils/http.js';

const toCents = (v) => Math.round(Number(v || 0) * 100);

export function readEventItems(value) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Agrega al menos un producto', 'MISSING_ITEMS');
  if (value.length > 50) throw badRequest('Demasiados productos', 'INVALID_FIELD');
  const map = new Map();
  for (const it of value) {
    const id = requireUuid(it?.product_id, 'product_id');
    const q = Number(it?.quantity ?? 1);
    if (!Number.isInteger(q) || q < 1 || q > 999) throw badRequest('Cantidad invalida', 'INVALID_FIELD');
    map.set(id, (map.get(id) || 0) + q);
  }
  return [...map.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
}

/** Lo vendido de cada producto (pedidos no cancelados). */
export async function soldByProduct(db, restaurantId, eventId) {
  return new Map((await db.query(
    `SELECT i.product_id, sum(i.quantity)::int AS sold
       FROM event_order_items i JOIN event_orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND o.event_id = $2 AND o.status <> 'cancelado'
      GROUP BY i.product_id`,
    [restaurantId, eventId],
  )).rows.map((r) => [r.product_id, r.sold]));
}

/**
 * Crea el pedido revisando cupo (con el evento bloqueado para que dos pedidos
 * a la vez no se pasen del cupo). input: { items, customer_name, customer_phone, notes, sellerId, paid, userId }
 */
export async function createEventOrder(db, restaurantId, eventId, input) {
  await db.query('SELECT 1 FROM events WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [eventId, restaurantId]);
  const products = new Map((await db.query(
    'SELECT id, name, price, max_quantity, active FROM event_products WHERE restaurant_id = $1 AND event_id = $2',
    [restaurantId, eventId],
  )).rows.map((p) => [p.id, p]));
  const sold = await soldByProduct(db, restaurantId, eventId);
  let total = 0;
  for (const it of input.items) {
    const p = products.get(it.product_id);
    if (!p || !p.active) throw badRequest('Ese producto no es de este evento', 'PRODUCT_NOT_FOUND');
    if (p.max_quantity != null) {
      const left = p.max_quantity - (sold.get(p.id) || 0);
      if (it.quantity > left) {
        throw new HttpError(409, left > 0 ? `Solo quedan ${left} de "${p.name}"` : `"${p.name}" ya se agoto`, 'EVENT_SOLD_OUT', { product_id: p.id, left: Math.max(0, left) });
      }
    }
    total += toCents(p.price) * it.quantity;
  }
  const folio = (await db.query('SELECT coalesce(max(folio), 0) + 1 AS n FROM event_orders WHERE restaurant_id = $1 AND event_id = $2', [restaurantId, eventId])).rows[0].n;
  const order = (await db.query(
    `INSERT INTO event_orders (restaurant_id, event_id, folio, customer_name, customer_phone, notes, seller_id, total, status, paid_at, paid_by, public_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 = 'pagado' THEN now() END, $10, $11) RETURNING *`,
    [restaurantId, eventId, folio, input.customer_name, input.customer_phone || null, input.notes || null, input.sellerId || null,
      total / 100, input.paid ? 'pagado' : 'pendiente', input.paid ? input.userId : null, crypto.randomBytes(18).toString('base64url')],
  )).rows[0];
  for (const it of input.items) {
    const p = products.get(it.product_id);
    await db.query(
      'INSERT INTO event_order_items (restaurant_id, order_id, product_id, name, price, quantity) VALUES ($1, $2, $3, $4, $5, $6)',
      [restaurantId, order.id, p.id, p.name, p.price, it.quantity],
    );
  }
  return order;
}

export async function loadEventOrders(db, restaurantId, where, params) {
  const orders = (await db.query(
    `SELECT o.id, o.event_id, o.folio, o.customer_name, o.customer_phone, o.notes, o.seller_id, u.name AS seller_name, o.status, o.total,
            o.paid_at, o.delivered_at, o.created_at, o.public_token
       FROM event_orders o LEFT JOIN users u ON u.id = o.seller_id AND u.restaurant_id = o.restaurant_id
      WHERE o.restaurant_id = $1 AND ${where} ORDER BY o.folio DESC LIMIT 1000`,
    [restaurantId, ...params],
  )).rows;
  if (!orders.length) return [];
  const items = (await db.query(
    'SELECT order_id, product_id, name, price, quantity FROM event_order_items WHERE restaurant_id = $1 AND order_id = ANY($2::uuid[])',
    [restaurantId, orders.map((o) => o.id)],
  )).rows;
  return orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id).map(({ order_id, ...i }) => i) }));
}

export const readCustomer = (b) => ({
  customer_name: str(b.customer_name, { field: 'customer_name', required: true, max: 120 }),
  customer_phone: str(b.customer_phone, { field: 'customer_phone', max: 30 }) || null,
  notes: str(b.notes, { field: 'notes', max: 500 }) || null,
});
