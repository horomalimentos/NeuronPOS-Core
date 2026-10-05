// Ordenes del POS: crear (comedor con mesa, para llevar, domicilio), agregar
// articulos con modificadores, enviar a cocina, descuentos, cancelar y cobrar
// (pagos divididos, cambio y propina). Tambien la pantalla de cocina (KDS).
//
// Flujo de estado: abierta -> enviada -> lista -> pagada, o cancelada (con
// motivo). Se puede cobrar desde abierta/enviada/lista; al cobrar, lo que no
// se habia enviado a cocina se envia.
//
// Los pedidos en linea (source = 'web', ver routes/pos/online.js) son
// ordenes normales: mientras esperan aceptacion (online_status = 'pendiente')
// no aparecen en "activas", no se envian a cocina y no se cobran.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { activeDeliveryOf } from '../../services/delivery/tenant.js';
import { calculateOrderTotals, discountPercentOf, normalizePayments, toCents } from '../../services/posMath.js';
import {
  HttpError, ah, badRequest, forbidden, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { ROLES, canAccessBranch, int, isManager, requireBranch, uuidList } from './common.js';
import { getSettings } from './settings.js';

const router = Router();

export const ORDER_TYPES = ['comedor', 'para_llevar', 'domicilio'];
export const ACTIVE_STATUSES = ['abierta', 'enviada', 'lista'];

const conflict = (msg, code) => new HttpError(409, msg, code);

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

const ORDER_SELECT = `
  SELECT o.id, o.branch_id, o.folio, o.order_type, o.table_id, t.name AS table_name, o.guests,
         o.customer_name, o.customer_phone, o.customer_address, o.notes, o.status,
         o.subtotal, o.discount_type, o.discount_value, o.discount_amount, o.discount_reason,
         o.tax_rate_pct, o.prices_include_tax, o.tax_amount, o.total, o.paid_amount, o.tip_amount,
         o.created_by, u.name AS created_by_name, o.sent_at, o.ready_at, o.paid_at,
         o.cancelled_at, o.cancel_reason, o.created_at, o.updated_at,
         o.source, o.online_status, o.customer_id, o.delivery_fee, o.delivery_reference,
         o.payment_provider, o.payment_preference, o.pay_with, o.accepted_at, o.estimated_ready_at,
         o.dispatched_at, o.public_token, o.online_payment_status, o.payment_due_at
    FROM orders o
    LEFT JOIN restaurant_tables t ON t.id = o.table_id AND t.restaurant_id = o.restaurant_id
    LEFT JOIN users u ON u.id = o.created_by AND u.restaurant_id = o.restaurant_id`;

export async function loadItems(db, restaurantId, orderIds) {
  const items = (await db.query(
    `SELECT id, order_id, menu_item_id, name, unit_price, modifiers_total, quantity, line_total,
            notes, sent_at, voided_at, void_reason, created_at
       FROM order_items WHERE restaurant_id = $1 AND order_id = ANY($2::uuid[])
      ORDER BY created_at, id`,
    [restaurantId, orderIds],
  )).rows;
  const mods = (await db.query(
    `SELECT m.order_item_id, m.modifier_id, m.group_name, m.name, m.price_delta
       FROM order_item_modifiers m
       JOIN order_items i ON i.id = m.order_item_id AND i.restaurant_id = m.restaurant_id
      WHERE m.restaurant_id = $1 AND i.order_id = ANY($2::uuid[])
      ORDER BY m.group_name, m.name`,
    [restaurantId, orderIds],
  )).rows;
  for (const it of items) it.modifiers = mods.filter((m) => m.order_item_id === it.id);
  return items;
}

/** Orden completa: articulos (con modificadores) y pagos. */
export async function loadOrder(db, restaurantId, id) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.id = $1 AND o.restaurant_id = $2`, [id, restaurantId]);
  const order = rows[0];
  if (!order) return null;
  order.items = await loadItems(db, restaurantId, [id]);
  order.payments = (await db.query(
    `SELECT p.id, p.payment_method_id, pm.name AS method_name, pm.kind AS method_kind, p.cash_session_id,
            p.amount, p.tip, p.received, p.change_given, p.reference, p.created_at
       FROM order_payments p
       JOIN payment_methods pm ON pm.id = p.payment_method_id AND pm.restaurant_id = p.restaurant_id
      WHERE p.restaurant_id = $1 AND p.order_id = $2 ORDER BY p.created_at`,
    [restaurantId, id],
  )).rows;
  return order;
}

/** Bloquea la orden (FOR UPDATE) y valida acceso a su sucursal. */
export async function lockOrder(db, req, id) {
  requireUuid(id);
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
    [id, req.tenant.id],
  );
  const order = rows[0];
  if (!order || !canAccessBranch(req.user, order.branch_id)) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
  return order;
}

export function assertActive(order) {
  if (!ACTIVE_STATUSES.includes(order.status)) {
    throw badRequest(order.status === 'pagada' ? 'La orden ya esta pagada' : 'La orden esta cancelada', 'ORDER_CLOSED');
  }
}

/** Un pedido en linea sin aceptar no va a cocina ni se cobra. */
function assertAccepted(order) {
  if (order.source === 'web' && order.online_status === 'pendiente') {
    throw badRequest('Acepta el pedido en linea antes de continuar', 'ONLINE_ORDER_PENDING');
  }
}

/**
 * Recalcula subtotal, descuento, impuesto y total con los articulos vigentes.
 * Nunca deja el total por debajo de lo ya pagado.
 */
export async function recalcOrder(db, restaurantId, order) {
  const items = (await db.query(
    `SELECT unit_price, modifiers_total, quantity, voided_at IS NOT NULL AS voided
       FROM order_items WHERE restaurant_id = $1 AND order_id = $2`,
    [restaurantId, order.id],
  )).rows;
  const totals = calculateOrderTotals(items, {
    discount: order.discount_type ? { type: order.discount_type, value: order.discount_value } : null,
    taxRatePct: order.tax_rate_pct,
    pricesIncludeTax: order.prices_include_tax,
    deliveryFee: order.delivery_fee,
  });
  if (toCents(totals.total) < toCents(order.paid_amount)) {
    throw badRequest('El total no puede quedar por debajo de lo ya pagado', 'TOTAL_BELOW_PAID');
  }
  await db.query(
    `UPDATE orders SET subtotal = $3, discount_amount = $4, tax_amount = $5, total = $6, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [order.id, restaurantId, totals.subtotal, totals.discount_amount, totals.tax_amount, totals.total],
  );
  return totals;
}

// ---------------------------------------------------------------------------
// Precios de articulos (siempre del lado del servidor)
// ---------------------------------------------------------------------------

export function readItemInputs(value) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Agrega al menos un articulo', 'MISSING_ITEMS');
  if (value.length > 100) throw badRequest('Demasiados articulos en una sola operacion', 'INVALID_FIELD');
  return value.map((it) => ({
    menu_item_id: requireUuid(it?.menu_item_id, 'menu_item_id'),
    quantity: int(it.quantity ?? 1, { field: 'quantity', min: 1, max: 999 }),
    modifier_ids: uuidList(it.modifier_ids ?? [], 'modifier_ids'),
    notes: str(it.notes, { field: 'notes', max: 300 }) || null,
  }));
}

/**
 * Valida productos y modificadores contra el menu del restaurante y la
 * disponibilidad de la sucursal. Regresa las lineas listas para insertar.
 */
export async function priceItems(db, restaurantId, branchId, inputs) {
  const itemIds = [...new Set(inputs.map((i) => i.menu_item_id))];
  const menuItems = new Map((await db.query(
    `SELECT i.id, i.name, i.price, i.active,
            coalesce(b.available, true) AS available
       FROM menu_items i
       LEFT JOIN menu_item_branches b ON b.menu_item_id = i.id AND b.branch_id = $3
      WHERE i.restaurant_id = $1 AND i.id = ANY($2::uuid[])`,
    [restaurantId, itemIds, branchId],
  )).rows.map((r) => [r.id, r]));
  const groups = (await db.query(
    `SELECT mg.menu_item_id, g.id, g.name, g.min_selections, g.max_selections
       FROM menu_item_modifier_groups mg
       JOIN modifier_groups g ON g.id = mg.modifier_group_id AND g.restaurant_id = mg.restaurant_id
      WHERE mg.restaurant_id = $1 AND mg.menu_item_id = ANY($2::uuid[]) AND g.active`,
    [restaurantId, itemIds],
  )).rows;
  const modIds = [...new Set(inputs.flatMap((i) => i.modifier_ids))];
  const modifiers = new Map((await db.query(
    `SELECT id, group_id, name, price_delta FROM modifiers
      WHERE restaurant_id = $1 AND id = ANY($2::uuid[]) AND active`,
    [restaurantId, modIds],
  )).rows.map((m) => [m.id, m]));

  return inputs.map((input) => {
    const mi = menuItems.get(input.menu_item_id);
    if (!mi || !mi.active) throw badRequest('Algun producto no existe o esta inactivo', 'ITEM_NOT_FOUND');
    if (!mi.available) throw badRequest(`"${mi.name}" no esta disponible en esta sucursal`, 'ITEM_UNAVAILABLE');
    const itemGroups = groups.filter((g) => g.menu_item_id === mi.id);
    const chosen = input.modifier_ids.map((id) => {
      const m = modifiers.get(id);
      const g = m && itemGroups.find((x) => x.id === m.group_id);
      if (!g) throw badRequest(`Algun modificador no aplica a "${mi.name}"`, 'MODIFIER_NOT_ALLOWED');
      return { ...m, group_name: g.name };
    });
    for (const g of itemGroups) {
      const n = chosen.filter((m) => m.group_id === g.id).length;
      if (n < g.min_selections) {
        throw badRequest(`"${mi.name}": elige al menos ${g.min_selections} en "${g.name}"`, 'MODIFIERS_REQUIRED');
      }
      if (g.max_selections !== null && n > g.max_selections) {
        throw badRequest(`"${mi.name}": maximo ${g.max_selections} en "${g.name}"`, 'MODIFIERS_EXCEEDED');
      }
    }
    const modsCents = chosen.reduce((s, m) => s + toCents(m.price_delta), 0);
    const unitCents = toCents(mi.price);
    if (unitCents + modsCents < 0) throw badRequest(`"${mi.name}": el precio no puede ser negativo`, 'INVALID_PRICE');
    return {
      menu_item_id: mi.id,
      name: mi.name,
      unit_price: unitCents / 100,
      modifiers_total: modsCents / 100,
      quantity: input.quantity,
      line_total: ((unitCents + modsCents) * input.quantity) / 100,
      notes: input.notes,
      modifiers: chosen,
    };
  });
}

/** Inserta las lineas ya valuadas. userId es NULL en pedidos en linea. */
export async function insertItems(db, restaurantId, orderId, userId, lines) {
  for (const l of lines) {
    const { rows } = await db.query(
      `INSERT INTO order_items (restaurant_id, order_id, menu_item_id, name, unit_price, modifiers_total,
                                quantity, line_total, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [restaurantId, orderId, l.menu_item_id, l.name, l.unit_price, l.modifiers_total, l.quantity, l.line_total, l.notes, userId],
    );
    for (const m of l.modifiers) {
      await db.query(
        `INSERT INTO order_item_modifiers (restaurant_id, order_item_id, modifier_id, group_name, name, price_delta)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [restaurantId, rows[0].id, m.id, m.group_name, m.name, m.price_delta],
      );
    }
  }
}

/** Mesa valida para una orden de comedor: de la sucursal, activa y libre. */
async function checkTable(db, restaurantId, branchId, tableId, exceptOrderId = null) {
  const { rows } = await db.query(
    `SELECT t.id, t.active,
            (SELECT o.id FROM orders o WHERE o.table_id = t.id AND o.restaurant_id = t.restaurant_id
               AND o.status IN ('abierta', 'enviada', 'lista') AND o.id IS DISTINCT FROM $4 LIMIT 1) AS busy
       FROM restaurant_tables t WHERE t.id = $1 AND t.restaurant_id = $2 AND t.branch_id = $3`,
    [tableId, restaurantId, branchId, exceptOrderId],
  );
  if (!rows[0] || !rows[0].active) throw badRequest('La mesa no existe en esta sucursal', 'TABLE_NOT_FOUND');
  if (rows[0].busy) throw conflict('La mesa ya tiene una orden abierta', 'TABLE_OCCUPIED');
}

/** Siguiente folio de la sucursal (el candado evita folios repetidos). */
export async function nextFolio(db, restaurantId, branchId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`folio:${branchId}`]);
  return (await db.query(
    'SELECT coalesce(max(folio), 0) + 1 AS n FROM orders WHERE branch_id = $1 AND restaurant_id = $2',
    [branchId, restaurantId],
  )).rows[0].n;
}

const isTableConflict = (err) => err?.code === '23505' && err.constraint === 'orders_one_active_per_table';

/**
 * Fase 5: cobrar en caja un domicilio. Si el repartidor propio ya lo llevaba
 * (recogido o en camino) queda entregado; si lo lleva la flota, se ajusta lo
 * que el repartidor debe cobrar en la puerta.
 */
async function afterRegisterPayment(db, restaurantId, orderId, paid) {
  if (paid) {
    await db.query(
      `UPDATE order_deliveries SET status = 'entregado', delivered_at = now(), updated_at = now()
        WHERE restaurant_id = $1 AND order_id = $2 AND status IN ('recogido', 'en_camino')`,
      [restaurantId, orderId],
    );
  }
  await db.query(
    `UPDATE delivery_requests r SET cash_to_collect = greatest(o.total - o.paid_amount, 0), updated_at = now()
       FROM orders o
      WHERE o.id = r.order_id AND o.restaurant_id = r.restaurant_id
        AND r.restaurant_id = $1 AND r.order_id = $2 AND r.status IN ('solicitado', 'asignado', 'recogido', 'en_camino')`,
    [restaurantId, orderId],
  );
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

router.get('/orders', requireRole(...ROLES.orders), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const status = oneOf(req.query.status || 'activas', ['activas', 'pagada', 'cancelada', 'todas'], 'status');
  const date = req.query.date ? String(req.query.date) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Fecha invalida', 'INVALID_DATE');
  const params = [req.tenant.id, branchId];
  let where = 'o.restaurant_id = $1 AND o.branch_id = $2';
  // Los pedidos en linea por aceptar se ven en /online-orders, no aqui.
  if (status === 'activas') {
    where += ` AND o.status IN ('abierta', 'enviada', 'lista') AND o.online_status IS DISTINCT FROM 'pendiente'`;
  }
  else if (status !== 'todas') { params.push(status); where += ` AND o.status = $${params.length}`; }
  if (date) {
    params.push(date);
    where += ` AND (o.created_at AT TIME ZONE (SELECT timezone FROM branches WHERE id = o.branch_id))::date = $${params.length}::date`;
  }
  const orders = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT 300`,
    params,
  )).rows);
  res.json({ orders });
}));

router.get('/orders/:id', requireRole(...ROLES.kitchen), ah(async (req, res) => {
  requireUuid(req.params.id);
  const order = await withTenant(req.tenant.id, (db) => loadOrder(db, req.tenant.id, req.params.id));
  if (!order || !canAccessBranch(req.user, order.branch_id)) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
  res.json({ order });
}));

router.post('/orders', requireRole(...ROLES.orders), ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const orderType = oneOf(body.order_type, ORDER_TYPES, 'order_type');
  if (!orderType) throw badRequest('El tipo de orden es obligatorio', 'MISSING_FIELD');
  const tableId = body.table_id ? requireUuid(body.table_id, 'table_id') : null;
  if (orderType === 'comedor' && !tableId) throw badRequest('Elige una mesa para comer aqui', 'TABLE_REQUIRED');
  if (orderType !== 'comedor' && tableId) throw badRequest('Solo las ordenes de comedor llevan mesa', 'INVALID_FIELD');
  const f = {
    guests: int(body.guests, { field: 'guests', min: 1, max: 100, nullable: true }) ?? null,
    customer_name: str(body.customer_name, { field: 'customer_name', max: 120 }) || null,
    customer_phone: str(body.customer_phone, { field: 'customer_phone', max: 40 }) || null,
    customer_address: str(body.customer_address, { field: 'customer_address', max: 400 }) || null,
    notes: str(body.notes, { field: 'notes', max: 500 }) || null,
  };
  if (orderType === 'domicilio' && (!f.customer_name || !f.customer_address)) {
    throw badRequest('Para domicilio se necesita nombre y direccion del cliente', 'CUSTOMER_REQUIRED');
  }
  const items = body.items === undefined || (Array.isArray(body.items) && body.items.length === 0)
    ? [] : readItemInputs(body.items);

  try {
    const order = await withTenant(req.tenant.id, async (db) => {
      const settings = await getSettings(db, req.tenant.id);
      const branch = await db.query('SELECT active FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id]);
      if (!branch.rows[0]) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
      if (!branch.rows[0].active) throw badRequest('La sucursal esta inactiva', 'BRANCH_INACTIVE');
      if (tableId) await checkTable(db, req.tenant.id, branchId, tableId);
      const lines = items.length ? await priceItems(db, req.tenant.id, branchId, items) : [];

      const folio = await nextFolio(db, req.tenant.id, branchId);

      const { rows } = await db.query(
        `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, table_id, guests, customer_name,
                             customer_phone, customer_address, notes, tax_rate_pct, prices_include_tax, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [req.tenant.id, branchId, folio, orderType, tableId, f.guests, f.customer_name, f.customer_phone,
          f.customer_address, f.notes, settings.tax_rate_pct, settings.prices_include_tax, req.user.id],
      );
      await insertItems(db, req.tenant.id, rows[0].id, req.user.id, lines);
      await recalcOrder(db, req.tenant.id, rows[0]);
      return loadOrder(db, req.tenant.id, rows[0].id);
    });
    res.status(201).json({ order });
  } catch (err) {
    if (isTableConflict(err)) throw conflict('La mesa ya tiene una orden abierta', 'TABLE_OCCUPIED');
    throw err;
  }
}));

// Datos del cliente, notas, comensales o cambio de mesa.
router.patch('/orders/:id', requireRole(...ROLES.orders), ah(async (req, res) => {
  const body = req.body || {};
  try {
    const order = await withTenant(req.tenant.id, async (db) => {
      const o = await lockOrder(db, req, req.params.id);
      assertActive(o);
      const f = {
        guests: int(body.guests, { field: 'guests', min: 1, max: 100, nullable: true }),
        customer_name: str(body.customer_name, { field: 'customer_name', max: 120 }),
        customer_phone: str(body.customer_phone, { field: 'customer_phone', max: 40 }),
        customer_address: str(body.customer_address, { field: 'customer_address', max: 400 }),
        notes: str(body.notes, { field: 'notes', max: 500 }),
      };
      if (body.table_id !== undefined) {
        if (o.order_type !== 'comedor') throw badRequest('Solo las ordenes de comedor llevan mesa', 'INVALID_FIELD');
        f.table_id = requireUuid(body.table_id, 'table_id');
        await checkTable(db, req.tenant.id, o.branch_id, f.table_id, o.id);
      }
      const entries = Object.entries(f).filter(([, v]) => v !== undefined);
      if (!entries.length) throw badRequest('No hay cambios', 'NO_CHANGES');
      await db.query(
        `UPDATE orders SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
          WHERE id = $1 AND restaurant_id = $2`,
        [o.id, req.tenant.id, ...entries.map(([, v]) => v)],
      );
      return loadOrder(db, req.tenant.id, o.id);
    });
    res.json({ order });
  } catch (err) {
    if (isTableConflict(err)) throw conflict('La mesa ya tiene una orden abierta', 'TABLE_OCCUPIED');
    throw err;
  }
}));

router.post('/orders/:id/items', requireRole(...ROLES.orders), ah(async (req, res) => {
  const inputs = readItemInputs((req.body || {}).items);
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    const lines = await priceItems(db, req.tenant.id, o.branch_id, inputs);
    await insertItems(db, req.tenant.id, o.id, req.user.id, lines);
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.status(201).json({ order });
}));

// Cambiar cantidad o notas de un articulo que todavia no se envia a cocina.
router.patch('/orders/:id/items/:itemId', requireRole(...ROLES.orders), ah(async (req, res) => {
  requireUuid(req.params.itemId);
  const body = req.body || {};
  const quantity = int(body.quantity, { field: 'quantity', min: 1, max: 999 });
  const notes = str(body.notes, { field: 'notes', max: 300 });
  if (quantity === undefined && notes === undefined) throw badRequest('No hay cambios', 'NO_CHANGES');
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    const { rows } = await db.query(
      'SELECT * FROM order_items WHERE id = $1 AND order_id = $2 AND restaurant_id = $3',
      [req.params.itemId, o.id, req.tenant.id],
    );
    const item = rows[0];
    if (!item) throw notFound('Articulo no encontrado', 'ORDER_ITEM_NOT_FOUND');
    if (item.sent_at) throw badRequest('El articulo ya se envio a cocina', 'ITEM_ALREADY_SENT');
    const qty = quantity ?? item.quantity;
    const lineTotal = ((toCents(item.unit_price) + toCents(item.modifiers_total)) * qty) / 100;
    await db.query(
      `UPDATE order_items SET quantity = $3, line_total = $4, notes = $5 WHERE id = $1 AND restaurant_id = $2`,
      [item.id, req.tenant.id, qty, lineTotal, notes === undefined ? item.notes : notes],
    );
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Quitar un articulo. Si no se ha enviado se borra; si ya se envio a cocina
// solo admin/gerente lo pueden cancelar, con motivo.
router.delete('/orders/:id/items/:itemId', requireRole(...ROLES.orders), ah(async (req, res) => {
  requireUuid(req.params.itemId);
  const reason = str((req.body || {}).reason ?? req.query.reason, { field: 'reason', max: 300 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    const { rows } = await db.query(
      'SELECT id, sent_at, voided_at FROM order_items WHERE id = $1 AND order_id = $2 AND restaurant_id = $3',
      [req.params.itemId, o.id, req.tenant.id],
    );
    const item = rows[0];
    if (!item || item.voided_at) throw notFound('Articulo no encontrado', 'ORDER_ITEM_NOT_FOUND');
    if (!item.sent_at) {
      await db.query('DELETE FROM order_items WHERE id = $1 AND restaurant_id = $2', [item.id, req.tenant.id]);
    } else {
      if (!isManager(req.user)) throw forbidden('Solo un gerente puede cancelar articulos ya enviados a cocina', 'ROLE_REQUIRED');
      if (!reason) throw badRequest('Escribe el motivo de la cancelacion', 'REASON_REQUIRED');
      await db.query(
        `UPDATE order_items SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND restaurant_id = $2`,
        [item.id, req.tenant.id, req.user.id, reason],
      );
    }
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

router.post('/orders/:id/send', requireRole(...ROLES.orders), ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    assertAccepted(o);
    const sent = await db.query(
      `UPDATE order_items SET sent_at = now()
        WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NULL AND voided_at IS NULL`,
      [o.id, req.tenant.id],
    );
    if (!sent.rowCount) throw badRequest('No hay articulos nuevos para enviar a cocina', 'NOTHING_TO_SEND');
    await db.query(
      `UPDATE orders SET status = 'enviada', sent_at = coalesce(sent_at, now()), updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id],
    );
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Cocina marca la orden como lista (todo lo enviado hasta ahora).
router.post('/orders/:id/ready', requireRole(...ROLES.kitchenReady), ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.status === 'cancelada') throw badRequest('La orden esta cancelada', 'ORDER_CLOSED');
    if (!o.sent_at) throw badRequest('La orden no se ha enviado a cocina', 'NOT_SENT');
    await db.query(
      `UPDATE orders SET ready_at = now(),
              status = CASE WHEN status = 'enviada' THEN 'lista' ELSE status END, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id],
    );
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Descuento a la cuenta: admin/gerente sin limite; cajero hasta el % de la
// configuracion; meseros no.
router.put('/orders/:id/discount', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const body = req.body || {};
  const type = oneOf(body.type, ['amount', 'percent'], 'type');
  if (!type) throw badRequest('El tipo de descuento es obligatorio', 'MISSING_FIELD');
  const value = money(body.value, { field: 'value' });
  if (!(value > 0)) throw badRequest('El descuento debe ser mayor a cero', 'INVALID_FIELD');
  if (type === 'percent' && value > 100) throw badRequest('El porcentaje no puede pasar de 100', 'INVALID_FIELD');
  const reason = str(body.reason, { field: 'reason', max: 300 }) || null;

  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    if (!isManager(req.user)) {
      const settings = await getSettings(db, req.tenant.id);
      const limit = Number(settings.cashier_max_discount_pct);
      const pct = discountPercentOf(o.subtotal, { type, value });
      if (!(limit > 0) || pct > limit + 1e-9) {
        throw forbidden(limit > 0
          ? `Tu rol puede descontar hasta ${limit}% de la cuenta`
          : 'Tu rol no puede aplicar descuentos', 'DISCOUNT_NOT_ALLOWED');
      }
    }
    o.discount_type = type;
    o.discount_value = value;
    await db.query(
      `UPDATE orders SET discount_type = $3, discount_value = $4, discount_reason = $5, discount_by = $6
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id, type, value, reason, req.user.id],
    );
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

router.delete('/orders/:id/discount', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    o.discount_type = null;
    o.discount_value = null;
    await db.query(
      `UPDATE orders SET discount_type = NULL, discount_value = NULL, discount_reason = NULL, discount_by = NULL
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id],
    );
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Cancelar con motivo. Un mesero solo cancela ordenes que no han ido a cocina.
router.post('/orders/:id/cancel', requireRole(...ROLES.orders), ah(async (req, res) => {
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, max: 300 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    if (toCents(o.paid_amount) > 0) throw badRequest('La orden ya tiene pagos registrados', 'ORDER_HAS_PAYMENTS');
    // Fase 5: un pedido con reparto en curso se cancela primero en el reparto.
    if (await activeDeliveryOf(db, req.tenant.id, o.id)) {
      throw conflict('El pedido tiene un reparto en curso: cancela o termina el reparto primero', 'DELIVERY_IN_PROGRESS');
    }
    if (!ROLES.cashier.includes(req.user.role) && o.sent_at) {
      throw forbidden('La orden ya se envio a cocina: pide a un cajero o gerente que la cancele', 'ROLE_REQUIRED');
    }
    // Cancelar un pedido en linea sin aceptar equivale a rechazarlo.
    await db.query(
      `UPDATE orders SET status = 'cancelada', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4, updated_at = now(),
              online_status = CASE WHEN online_status = 'pendiente' THEN 'rechazada' ELSE online_status END
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id, req.user.id, reason],
    );
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Cobro: uno o varios pagos (dividir cuenta). Se registran en el turno de
// caja indicado (abierto y de la misma sucursal). Cuando el saldo llega a 0
// la orden queda pagada.
router.post('/orders/:id/payments', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const body = req.body || {};
  const sessionId = requireUuid(body.cash_session_id, 'cash_session_id');
  if (!Array.isArray(body.payments)) throw badRequest('payments debe ser una lista', 'INVALID_FIELD');
  if (body.payments.length > 20) throw badRequest('Demasiados pagos', 'INVALID_FIELD');
  const inputs = body.payments.map((p) => ({
    payment_method_id: requireUuid(p?.payment_method_id, 'payment_method_id'),
    amount: money(p.amount ?? 0, { field: 'amount' }),
    tip: money(p.tip ?? 0, { field: 'tip' }),
    received: p.received === undefined || p.received === null || p.received === ''
      ? undefined : money(p.received, { field: 'received' }),
    reference: str(p.reference, { field: 'reference', max: 100 }) || null,
  }));

  const result = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    assertAccepted(o);
    const live = await db.query(
      'SELECT count(*)::int AS n FROM order_items WHERE order_id = $1 AND restaurant_id = $2 AND voided_at IS NULL',
      [o.id, req.tenant.id],
    );
    if (!live.rows[0].n) throw badRequest('La orden no tiene articulos', 'EMPTY_ORDER');

    const session = (await db.query(
      'SELECT id, branch_id, status FROM cash_sessions WHERE id = $1 AND restaurant_id = $2',
      [sessionId, req.tenant.id],
    )).rows[0];
    if (!session || session.status !== 'abierta' || session.branch_id !== o.branch_id) {
      throw badRequest('Abre la caja de esta sucursal antes de cobrar', 'CASH_SESSION_REQUIRED');
    }

    const methods = new Map((await db.query(
      'SELECT id, kind, active FROM payment_methods WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
      [req.tenant.id, inputs.map((p) => p.payment_method_id)],
    )).rows.map((m) => [m.id, m]));
    const lines = inputs.map((p) => {
      const m = methods.get(p.payment_method_id);
      if (!m || !m.active) throw badRequest('Metodo de pago no valido', 'PAYMENT_METHOD_NOT_FOUND');
      if (m.kind === 'en_linea') throw badRequest('Los pagos en linea solo los registra Clip', 'ONLINE_METHOD_NOT_ALLOWED');
      return { ...p, kind: m.kind };
    });
    const remaining = (toCents(o.total) - toCents(o.paid_amount)) / 100;
    if (!lines.length && remaining > 0) throw badRequest('Agrega al menos un pago', 'MISSING_PAYMENTS');
    const norm = normalizePayments(lines, remaining);

    for (const [i, p] of norm.lines.entries()) {
      await db.query(
        `INSERT INTO order_payments (restaurant_id, order_id, payment_method_id, cash_session_id, amount, tip,
                                     received, change_given, reference, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [req.tenant.id, o.id, lines[i].payment_method_id, sessionId, p.amount, p.tip, p.received,
          p.change_given, lines[i].reference, req.user.id],
      );
    }
    const tips = norm.lines.reduce((s, p) => s + toCents(p.tip), 0);
    const paid = norm.remaining_after === 0;
    await db.query(
      `UPDATE orders SET paid_amount = paid_amount + $3, tip_amount = tip_amount + $4,
              status = CASE WHEN $5 THEN 'pagada' ELSE status END,
              paid_at = CASE WHEN $5 THEN now() ELSE paid_at END,
              sent_at = CASE WHEN $5 THEN coalesce(sent_at, now()) ELSE sent_at END,
              updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id, norm.applied, tips / 100, paid],
    );
    if (paid) {
      // Lo que no se habia mandado a cocina se manda al cobrar.
      await db.query(
        `UPDATE order_items SET sent_at = now()
          WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NULL AND voided_at IS NULL`,
        [o.id, req.tenant.id],
      );
    }
    if (o.order_type === 'domicilio') await afterRegisterPayment(db, req.tenant.id, o.id, paid);
    return {
      order: await loadOrder(db, req.tenant.id, o.id),
      change: norm.change,
      remaining: norm.remaining_after,
    };
  });
  res.status(201).json(result);
}));

// ---------------------------------------------------------------------------
// Cocina (KDS): ordenes con articulos enviados que aun no se marcan listos.
// ---------------------------------------------------------------------------

router.get('/kitchen', requireRole(...ROLES.kitchen), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const orders = await withTenant(req.tenant.id, async (db) => {
    const list = (await db.query(
      `${ORDER_SELECT}
        WHERE o.restaurant_id = $1 AND o.branch_id = $2 AND o.status <> 'cancelada'
          AND o.created_at > now() - interval '24 hours'
          AND EXISTS (SELECT 1 FROM order_items i
                       WHERE i.order_id = o.id AND i.restaurant_id = o.restaurant_id
                         AND i.sent_at IS NOT NULL AND i.voided_at IS NULL
                         AND (o.ready_at IS NULL OR i.sent_at > o.ready_at))
        ORDER BY o.sent_at, o.created_at`,
      [req.tenant.id, branchId],
    )).rows;
    if (!list.length) return [];
    const items = await loadItems(db, req.tenant.id, list.map((o) => o.id));
    return list.map((o) => ({
      ...o,
      items: items
        .filter((i) => i.order_id === o.id && i.sent_at && !i.voided_at)
        .map((i) => ({ ...i, is_new: !o.ready_at || new Date(i.sent_at) > new Date(o.ready_at) })),
    }));
  });
  res.json({ orders });
}));

export default router;
