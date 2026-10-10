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
import { deductOrder } from '../../services/inventory.js';
import { commitRedemption, countingCodeFailures, earnForOrder, prepareRedemption } from '../../services/loyalty.js';
import { commitWalletPayment, prepareWalletPayment } from '../../services/wallet.js';
import { activeDeliveryOf } from '../../services/delivery/tenant.js';
import { verifyApprovalPin, pinExpiresAt, pinFor, pinLocked } from '../../services/approvalPin.js';
import { calculateOrderTotals, discountCents, discountPercentOf, normalizePayments, toCents } from '../../services/posMath.js';
import { assertDeviceBranch, requireDevice } from '../../services/devices.js';
import { promotionsFor } from '../../services/promotions.js';
import { findVoucher, redeemOrderVoucher, voucherDiscountCents, voucherProblem } from '../../services/vouchers.js';
import {
  HttpError, ah, badRequest, forbidden, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { ROLES, assertModule, canAccessBranch, int, isManager, moduleActive, requireBranch, uuidList } from './common.js';
import { getSettings } from './settings.js';
import { can, hasCapability } from '../../services/permissions.js';

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
         o.dispatched_at, o.public_token, o.online_payment_status, o.payment_due_at, o.scheduled_for,
         o.delivery_latitude, o.delivery_longitude, o.delivery_distance_km,
         o.channel_id, ch.name AS channel_name, ch.color AS channel_color, o.channel_order_number,
         o.channel_commission_pct, o.promo_discount, o.item_discount,
         o.voucher_id, o.voucher_discount, vo.code AS voucher_code, o.dine_in
    FROM orders o
    LEFT JOIN restaurant_tables t ON t.id = o.table_id AND t.restaurant_id = o.restaurant_id
    LEFT JOIN sales_channels ch ON ch.id = o.channel_id AND ch.restaurant_id = o.restaurant_id
    LEFT JOIN vouchers vo ON vo.id = o.voucher_id AND vo.restaurant_id = o.restaurant_id
    LEFT JOIN users u ON u.id = o.created_by AND u.restaurant_id = o.restaurant_id`;

export async function loadItems(db, restaurantId, orderIds) {
  const items = (await db.query(
    `SELECT i.id, i.order_id, i.menu_item_id, i.name, i.unit_price, i.modifiers_total, i.quantity, i.line_total,
            i.notes, i.sent_at, i.ready_at, i.voided_at, i.void_reason, i.created_at, i.station_id,
            i.discount_type, i.discount_value, i.discount_amount, i.discount_reason,
            s.name AS station_name
       FROM order_items i
       LEFT JOIN kitchen_stations s ON s.id = i.station_id AND s.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.order_id = ANY($2::uuid[])
      ORDER BY i.created_at, i.id`,
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
  order.promotions = (await db.query(
    'SELECT promotion_id, name, amount FROM order_promotions WHERE restaurant_id = $1 AND order_id = $2 ORDER BY amount DESC',
    [restaurantId, id],
  )).rows;
  order.payments = (await db.query(
    `SELECT p.id, p.payment_method_id, pm.name AS method_name, pm.kind AS method_kind, p.cash_session_id,
            p.amount, p.tip, p.received, p.change_given, p.reference, p.created_at,
            p.currency, p.foreign_received, p.exchange_rate
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
    `SELECT i.id, i.menu_item_id, i.unit_price, i.modifiers_total, i.quantity, i.voided_at IS NOT NULL AS voided,
            i.discount_type, i.discount_value, i.discount_amount,
            coalesce((SELECT array_agg(m.modifier_id) FROM order_item_modifiers m
                       WHERE m.order_item_id = i.id AND m.restaurant_id = i.restaurant_id), '{}') AS modifier_ids
       FROM order_items i WHERE i.restaurant_id = $1 AND i.order_id = $2`,
    [restaurantId, order.id],
  )).rows;
  // Promociones automaticas (modulo "promociones"): se recalculan con cada cambio mientras no se pague.
  const promos = await moduleActive(db, restaurantId, 'promociones')
    ? await promotionsFor(db, restaurantId, { branchId: order.branch_id, source: order.source || 'pos', lines: items })
    : [];
  // Vale (modulo "promociones"): sobre lo que queda despues de las promociones.
  // Si ya no aplica (vencio, cambio la orden...) se quita.
  let voucherCents = 0;
  if (order.voucher_id) {
    const v = (await db.query('SELECT * FROM vouchers WHERE id = $1 AND restaurant_id = $2', [order.voucher_id, restaurantId])).rows[0];
    const subtotalCents = items.filter((i) => !i.voided).reduce((s, i) => s + (toCents(i.unit_price) + toCents(i.modifiers_total)) * Number(i.quantity), 0);
    const baseCents = subtotalCents - promos.reduce((s, p) => s + p.cents, 0);
    const tz = (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [order.branch_id, restaurantId])).rows[0]?.timezone;
    const problem = await voucherProblem(db, restaurantId, v, { source: order.source || 'pos', timezone: tz, baseCents, lines: items, orderId: order.id });
    if (problem || !(await moduleActive(db, restaurantId, 'promociones'))) {
      await db.query('UPDATE orders SET voucher_id = NULL WHERE id = $1 AND restaurant_id = $2', [order.id, restaurantId]);
      order.voucher_id = null;
    } else {
      voucherCents = voucherDiscountCents(v, { baseCents, lines: items });
    }
  }
  // Descuento de cada articulo sobre su importe (los quitados no cuentan).
  let itemCents = 0;
  for (const it of items) {
    const cents = it.voided || !it.discount_type ? 0
      : discountCents((toCents(it.unit_price) + toCents(it.modifiers_total)) * Number(it.quantity), { type: it.discount_type, value: it.discount_value });
    itemCents += cents;
    if (toCents(it.discount_amount) !== cents) {
      await db.query('UPDATE order_items SET discount_amount = $3 WHERE id = $1 AND restaurant_id = $2', [it.id, restaurantId, cents / 100]);
    }
  }
  const totals = calculateOrderTotals(items, {
    discount: order.discount_type ? { type: order.discount_type, value: order.discount_value } : null,
    taxRatePct: order.tax_rate_pct,
    pricesIncludeTax: order.prices_include_tax,
    deliveryFee: order.delivery_fee,
    promoDiscount: (promos.reduce((s, p) => s + p.cents, 0) + voucherCents) / 100,
    itemDiscount: itemCents / 100,
  });
  if (toCents(totals.total) < toCents(order.paid_amount)) {
    throw badRequest('El total no puede quedar por debajo de lo ya pagado', 'TOTAL_BELOW_PAID');
  }
  await db.query('DELETE FROM order_promotions WHERE order_id = $1 AND restaurant_id = $2', [order.id, restaurantId]);
  for (const p of promos) {
    await db.query(
      'INSERT INTO order_promotions (restaurant_id, order_id, promotion_id, name, amount) VALUES ($1, $2, $3, $4, $5)',
      [restaurantId, order.id, p.promotion_id, p.name, p.cents / 100],
    );
  }
  await db.query(
    `UPDATE orders SET subtotal = $3, discount_amount = $4, tax_amount = $5, total = $6, promo_discount = $7,
            item_discount = $8, voucher_discount = $9, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [order.id, restaurantId, totals.subtotal, totals.discount_amount, totals.tax_amount, totals.total, totals.promo_discount,
      totals.item_discount, voucherCents / 100],
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
            coalesce(b.available OR coalesce(b.unavailable_until <= now(), false), true) AS available,
            coalesce(i.station_id, c.station_id) AS station_id
       FROM menu_items i
       LEFT JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
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
      station_id: mi.station_id,
      modifiers: chosen,
    };
  });
}

/** Inserta las lineas ya valuadas. userId es NULL en pedidos en linea. */
export async function insertItems(db, restaurantId, orderId, userId, lines) {
  for (const l of lines) {
    const { rows } = await db.query(
      `INSERT INTO order_items (restaurant_id, order_id, menu_item_id, name, unit_price, modifiers_total,
                                quantity, line_total, notes, created_by, station_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [restaurantId, orderId, l.menu_item_id, l.name, l.unit_price, l.modifiers_total, l.quantity, l.line_total, l.notes,
        userId, l.station_id || null],
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

router.get('/orders', can('orders'), ah(async (req, res) => {
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

router.get('/orders/:id', can('kitchen'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const order = await withTenant(req.tenant.id, (db) => loadOrder(db, req.tenant.id, req.params.id));
  if (!order || !canAccessBranch(req.user, order.branch_id)) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
  res.json({ order });
}));

router.post('/orders', can('orders'), ah(async (req, res) => {
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
    channel_order_number: str(body.channel_order_number, { field: 'channel_order_number', max: 60 }) || null,
  };
  const channelId = body.channel_id ? requireUuid(body.channel_id, 'channel_id') : null;
  // Kiosko de autoservicio (modulo "kiosko"): para llevar, con nombre; "comer aqui" sin mesa.
  const kiosk = body.source === 'kiosko';
  if (kiosk && (orderType !== 'para_llevar' || channelId || !f.customer_name)) {
    throw badRequest('El kiosko crea ordenes para llevar con el nombre del cliente', 'INVALID_FIELD');
  }
  if (channelId && orderType === 'comedor') throw badRequest('Las plataformas solo aplican para llevar o domicilio', 'INVALID_FIELD');
  // Con plataforma, la entrega y los datos del cliente los lleva la plataforma.
  if (orderType === 'domicilio' && !channelId && (!f.customer_name || !f.customer_address)) {
    throw badRequest('Para domicilio se necesita nombre y direccion del cliente', 'CUSTOMER_REQUIRED');
  }
  const items = body.items === undefined || (Array.isArray(body.items) && body.items.length === 0)
    ? [] : readItemInputs(body.items);

  try {
    const order = await withTenant(req.tenant.id, async (db) => {
      const settings = await getSettings(db, req.tenant.id);
      const branch = await db.query('SELECT active, tax_rate_pct FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id]);
      if (!branch.rows[0]) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
      if (!branch.rows[0].active) throw badRequest('La sucursal esta inactiva', 'BRANCH_INACTIVE');
      if (tableId) await checkTable(db, req.tenant.id, branchId, tableId);
      if (kiosk) await assertModule(db, req.tenant.id, 'kiosko', 'Kiosko de autoservicio');
      let commission = 0;
      if (channelId) {
        await assertModule(db, req.tenant.id, 'plataformas', 'Plataformas de delivery');
        const ch = (await db.query(
          'SELECT name, active, commission_pct, requires_order_number, requires_address FROM sales_channels WHERE id = $1 AND restaurant_id = $2',
          [channelId, req.tenant.id],
        )).rows[0];
        if (!ch || !ch.active) throw badRequest('La plataforma no existe o esta inactiva', 'CHANNEL_NOT_FOUND');
        if (ch.requires_order_number && !f.channel_order_number) {
          throw badRequest(`Escribe el numero de pedido de ${ch.name}`, 'CHANNEL_ORDER_NUMBER_REQUIRED');
        }
        if (ch.requires_address && orderType === 'domicilio' && !f.customer_address) {
          throw badRequest('Escribe la direccion de entrega', 'CUSTOMER_REQUIRED');
        }
        commission = ch.commission_pct;
      }
      const lines = items.length ? await priceItems(db, req.tenant.id, branchId, items) : [];

      const folio = await nextFolio(db, req.tenant.id, branchId);

      const { rows } = await db.query(
        `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, table_id, guests, customer_name,
                             customer_phone, customer_address, notes, tax_rate_pct, prices_include_tax, created_by,
                             channel_id, channel_order_number, channel_commission_pct, source, dine_in)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
        [req.tenant.id, branchId, folio, orderType, tableId, f.guests, f.customer_name, f.customer_phone,
          f.customer_address, f.notes, branch.rows[0].tax_rate_pct ?? settings.tax_rate_pct, settings.prices_include_tax, req.user.id,
          channelId, channelId ? f.channel_order_number : null, commission, kiosk ? 'kiosko' : 'pos', kiosk && body.dine_in === true],
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
router.patch('/orders/:id', can('orders'), ah(async (req, res) => {
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
        channel_order_number: o.channel_id ? str(body.channel_order_number, { field: 'channel_order_number', max: 60 }) : undefined,
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

router.post('/orders/:id/items', can('orders'), ah(async (req, res) => {
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
router.patch('/orders/:id/items/:itemId', can('orders'), ah(async (req, res) => {
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
router.delete('/orders/:id/items/:itemId', can('orders'), ah(async (req, res) => {
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
      if (!(await hasCapability(req, 'voidSent'))) throw forbidden('Tu rol no puede quitar articulos ya enviados a cocina', 'ROLE_REQUIRED');
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

router.post('/orders/:id/send', can('orders'), ah(async (req, res) => {
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

// Cocina marca como listo lo enviado hasta ahora. Con station_id solo lo de
// esa estacion ("general" = lo que no tiene estacion); la orden queda lista
// cuando ya no le queda nada pendiente.
router.post('/orders/:id/ready', can('kitchenReady'), ah(async (req, res) => {
  const raw = req.body?.station_id;
  const general = raw === 'general';
  const stationId = raw && !general ? requireUuid(raw, 'station_id') : null;
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.status === 'cancelada') throw badRequest('La orden esta cancelada', 'ORDER_CLOSED');
    if (!o.sent_at) throw badRequest('La orden no se ha enviado a cocina', 'NOT_SENT');
    await db.query(
      `UPDATE order_items SET ready_at = now()
        WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NOT NULL AND ready_at IS NULL AND voided_at IS NULL
          ${general ? 'AND station_id IS NULL' : stationId ? 'AND station_id = $3' : ''}`,
      stationId ? [o.id, req.tenant.id, stationId] : [o.id, req.tenant.id],
    );
    const pending = await db.query(
      `SELECT 1 FROM order_items
        WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NOT NULL AND ready_at IS NULL AND voided_at IS NULL
        LIMIT 1`,
      [o.id, req.tenant.id],
    );
    if (!pending.rowCount) {
      await db.query(
        `UPDATE orders SET ready_at = now(),
                status = CASE WHEN status = 'enviada' THEN 'lista' ELSE status END, updated_at = now()
          WHERE id = $1 AND restaurant_id = $2`,
        [o.id, req.tenant.id],
      );
    }
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// ---------------------------------------------------------------------------
// Descuentos: limite del cajero y PIN del gerente
// ---------------------------------------------------------------------------

/**
 * Admin y gerente descuentan sin limite. El cajero hasta el % de la
 * configuracion; arriba de eso (o si su limite es 0) necesita el PIN de un
 * gerente. Regresa el id de quien autoriza (el usuario o el gerente).
 */
async function authorizeDiscount(db, req, pct, pin, what) {
  if (isManager(req.user)) return req.user.id;
  const settings = await getSettings(db, req.tenant.id);
  const limit = Number(settings.cashier_max_discount_pct);
  if (limit > 0 && pct <= limit + 1e-9) return req.user.id;
  if (!pin) {
    throw forbidden(limit > 0
      ? `Tu rol puede descontar hasta ${limit}% ${what}. Pide el PIN del gerente.`
      : 'Tu rol no puede aplicar descuentos sin el PIN del gerente', 'DISCOUNT_NOT_ALLOWED');
  }
  if (pinLocked(req.user.id)) throw new HttpError(429, 'Demasiados intentos con PIN. Espera unos minutos.', 'PIN_LOCKED');
  const approver = await verifyApprovalPin(db, req.tenant.id, req.user.id, pin);
  if (!approver) throw forbidden('El PIN no es valido o ya vencio', 'INVALID_PIN');
  return approver;
}

// Aplicar un vale por su codigo ({ code }; null lo quita). Modulo "promociones".
router.put('/orders/:id/voucher', can('orders'), ah(async (req, res) => {
  const code = req.body?.code ? String(req.body.code) : null;
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    if (code) {
      await assertModule(db, req.tenant.id, 'promociones', 'Promociones');
      const v = await findVoucher(db, req.tenant.id, code);
      if (!v) throw badRequest('El vale no existe', 'VOUCHER_NOT_FOUND');
      const items = (await db.query(
        'SELECT menu_item_id, unit_price, modifiers_total, quantity, voided_at IS NOT NULL AS voided FROM order_items WHERE order_id = $1 AND restaurant_id = $2',
        [o.id, req.tenant.id],
      )).rows;
      const tz = (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [o.branch_id, req.tenant.id])).rows[0]?.timezone;
      const problem = await voucherProblem(db, req.tenant.id, v, {
        source: o.source, timezone: tz, baseCents: toCents(o.subtotal) - toCents(o.promo_discount) + toCents(o.voucher_discount), lines: items, orderId: o.id,
      });
      if (problem) throw badRequest(problem, 'VOUCHER_NOT_APPLICABLE');
      o.voucher_id = v.id;
    } else {
      o.voucher_id = null;
    }
    await db.query('UPDATE orders SET voucher_id = $3 WHERE id = $1 AND restaurant_id = $2', [o.id, req.tenant.id, o.voucher_id]);
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// PIN vigente del gerente para dictarlo al cajero (cambia cada 10 minutos).
router.get('/approval-pin', can('manage'), (req, res) => {
  res.json({ pin: pinFor(req.user.id), expires_at: pinExpiresAt() });
});

// Descuento a un articulo (en % o $ sobre su importe).
router.put('/orders/:id/items/:itemId/discount', can('cashier'), ah(async (req, res) => {
  requireUuid(req.params.itemId, 'itemId');
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
    const it = (await db.query(
      'SELECT unit_price, modifiers_total, quantity, voided_at FROM order_items WHERE id = $1 AND order_id = $2 AND restaurant_id = $3',
      [req.params.itemId, o.id, req.tenant.id],
    )).rows[0];
    if (!it || it.voided_at) throw notFound('Articulo no encontrado', 'ITEM_NOT_FOUND');
    const line = (toCents(it.unit_price) + toCents(it.modifiers_total)) * it.quantity / 100;
    const by = await authorizeDiscount(db, req, discountPercentOf(line, { type, value }), body.pin, 'por articulo');
    await db.query(
      `UPDATE order_items SET discount_type = $3, discount_value = $4, discount_reason = $5, discount_by = $6
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.itemId, req.tenant.id, type, value, reason, by],
    );
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

router.delete('/orders/:id/items/:itemId/discount', can('cashier'), ah(async (req, res) => {
  requireUuid(req.params.itemId, 'itemId');
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    await db.query(
      `UPDATE order_items SET discount_type = NULL, discount_value = NULL, discount_amount = 0, discount_reason = NULL, discount_by = NULL
        WHERE id = $1 AND order_id = $2 AND restaurant_id = $3`,
      [req.params.itemId, o.id, req.tenant.id],
    );
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Descuento a la cuenta: admin/gerente sin limite; cajero hasta el % de la
// configuracion; meseros no.
router.put('/orders/:id/discount', can('cashier'), ah(async (req, res) => {
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
    const base = Math.max(0, toCents(o.subtotal) - toCents(o.promo_discount) - toCents(o.item_discount)) / 100;
    const by = await authorizeDiscount(db, req, discountPercentOf(base, { type, value }), body.pin, 'de la cuenta');
    o.discount_type = type;
    o.discount_value = value;
    await db.query(
      `UPDATE orders SET discount_type = $3, discount_value = $4, discount_reason = $5, discount_by = $6
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id, type, value, reason, by],
    );
    await recalcOrder(db, req.tenant.id, o);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

router.delete('/orders/:id/discount', can('cashier'), ah(async (req, res) => {
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
router.post('/orders/:id/cancel', can('orders'), ah(async (req, res) => {
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, max: 300 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    if (toCents(o.paid_amount) > 0) throw badRequest('La orden ya tiene pagos registrados', 'ORDER_HAS_PAYMENTS');
    // Fase 5: un pedido con reparto en curso se cancela primero en el reparto.
    if (await activeDeliveryOf(db, req.tenant.id, o.id)) {
      throw conflict('El pedido tiene un reparto en curso: cancela o termina el reparto primero', 'DELIVERY_IN_PROGRESS');
    }
    if (o.sent_at && !(await hasCapability(req, 'cancelSent'))) {
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
router.post('/orders/:id/payments', can('cashier'), requireDevice, ah(async (req, res) => {
  const body = req.body || {};
  const sessionId = requireUuid(body.cash_session_id, 'cash_session_id');
  if (!Array.isArray(body.payments)) throw badRequest('payments debe ser una lista', 'INVALID_FIELD');
  if (body.payments.length > 20) throw badRequest('Demasiados pagos', 'INVALID_FIELD');
  const inputs = body.payments.map((p) => ({
    // Pago con puntos: { loyalty: { customer_id, points, code } }; el metodo y el monto los pone el servidor.
    loyalty: p?.loyalty && typeof p.loyalty === 'object' ? p.loyalty : null,
    // Pago con monedero: { wallet: { customer_id, amount, code } }.
    wallet: p?.wallet && typeof p.wallet === 'object' && !p?.loyalty ? p.wallet : null,
    payment_method_id: p?.loyalty || p?.wallet ? null : requireUuid(p?.payment_method_id, 'payment_method_id'),
    amount: money(p.amount ?? 0, { field: 'amount' }),
    tip: money(p.tip ?? 0, { field: 'tip' }),
    received: p.received === undefined || p.received === null || p.received === ''
      ? undefined : money(p.received, { field: 'received' }),
    // Efectivo en dolares: lo recibido en USD (se convierte con el tipo de cambio del turno).
    received_usd: p.received_usd === undefined || p.received_usd === null || p.received_usd === ''
      ? undefined : money(p.received_usd, { field: 'received_usd' }),
    reference: str(p.reference, { field: 'reference', max: 100 }) || null,
    // Cobro aprobado en la terminal Clip (se verifica y se marca usado).
    clip_cobro_id: p.clip_cobro_id ? requireUuid(p.clip_cobro_id, 'clip_cobro_id') : null,
  }));

  const result = await countingCodeFailures(req.tenant.id, () => withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    assertActive(o);
    assertAccepted(o);
    const live = await db.query(
      'SELECT count(*)::int AS n FROM order_items WHERE order_id = $1 AND restaurant_id = $2 AND voided_at IS NULL',
      [o.id, req.tenant.id],
    );
    if (!live.rows[0].n) throw badRequest('La orden no tiene articulos', 'EMPTY_ORDER');

    const session = (await db.query(
      'SELECT id, branch_id, status, usd_rate FROM cash_sessions WHERE id = $1 AND restaurant_id = $2',
      [sessionId, req.tenant.id],
    )).rows[0];
    if (!session || session.status !== 'abierta' || session.branch_id !== o.branch_id) {
      throw badRequest('Abre la caja de esta sucursal antes de cobrar', 'CASH_SESSION_REQUIRED');
    }
    assertDeviceBranch(req, session.branch_id);

    for (const p of inputs.filter((x) => x.loyalty)) {
      if (inputs.filter((x) => x.loyalty).length > 1) throw badRequest('Solo un canje de puntos por cobro', 'INVALID_FIELD');
      p.redemption = await prepareRedemption(db, req.tenant.id, o, p.loyalty);
      Object.assign(p, { payment_method_id: p.redemption.methodId, amount: p.redemption.amount, tip: 0, received: undefined });
    }
    const walletLines = inputs.filter((x) => x.wallet);
    if (walletLines.length > 1) throw badRequest('Solo un pago con monedero por cobro', 'INVALID_FIELD');
    for (const p of walletLines) {
      p.walletPay = await prepareWalletPayment(db, req.tenant.id, o, p.wallet);
      const other = inputs.find((x) => x.redemption);
      if (other && other.redemption.customerId !== p.walletPay.customerId) {
        throw badRequest('Los puntos y el monedero deben ser del mismo cliente', 'CUSTOMER_MISMATCH');
      }
      Object.assign(p, { payment_method_id: p.walletPay.methodId, amount: p.walletPay.amount, tip: 0, received: undefined });
    }
    const methods = new Map((await db.query(
      'SELECT id, kind, currency, active FROM payment_methods WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
      [req.tenant.id, inputs.map((p) => p.payment_method_id)],
    )).rows.map((m) => [m.id, m]));
    // Una plataforma puede limitar con que se cobra (ej. solo "Rappi pagado").
    const allowed = o.channel_id ? (await db.query(
      'SELECT payment_method_ids FROM sales_channels WHERE id = $1 AND restaurant_id = $2',
      [o.channel_id, req.tenant.id],
    )).rows[0]?.payment_method_ids || [] : [];
    const usdEnabled = [...methods.values()].some((m) => m.currency === 'USD') && await moduleActive(db, req.tenant.id, 'multimoneda');
    const lines = inputs.map((p) => {
      const m = methods.get(p.payment_method_id);
      if (p.redemption || p.walletPay) return { ...p, kind: m.kind, currency: 'MXN' };
      if (m?.kind === 'puntos') throw badRequest('Los puntos se canjean con el botón de puntos', 'POINTS_METHOD_NOT_ALLOWED');
      if (m?.kind === 'monedero') throw badRequest('El monedero se cobra con el botón de monedero', 'WALLET_METHOD_NOT_ALLOWED');
      if (!m || !m.active) throw badRequest('Metodo de pago no valido', 'PAYMENT_METHOD_NOT_FOUND');
      if (m.kind === 'en_linea') throw badRequest('Los pagos en linea solo los registra Clip', 'ONLINE_METHOD_NOT_ALLOWED');
      if (allowed.length && !allowed.includes(p.payment_method_id)) {
        throw badRequest('Ese metodo de pago no aplica para esta plataforma', 'PAYMENT_METHOD_NOT_ALLOWED');
      }
      if (m.currency === 'USD') {
        if (!usdEnabled) throw new HttpError(402, 'Tu restaurante no tiene contratado el modulo "Cobro en dolares"', 'MODULE_NOT_ENABLED');
        if (!(p.received_usd > 0)) throw badRequest('Indica cuantos dolares se recibieron', 'MISSING_FIELD');
        const rate = Number(session.usd_rate);
        if (!(rate > 0)) throw badRequest('El turno no tiene tipo de cambio', 'USD_RATE_REQUIRED');
        // Lo recibido en pesos; el cambio se da en pesos.
        return { ...p, kind: m.kind, currency: 'USD', rate, received: Math.round(p.received_usd * rate * 100) / 100 };
      }
      return { ...p, kind: m.kind, currency: 'MXN' };
    });
    // Pagos con la terminal Clip: el cobro debe estar aprobado, ser de esta
    // orden, no haberse usado y cuadrar con monto + propina; el metodo, tarjeta.
    for (const l of lines) {
      if (!l.clip_cobro_id) continue;
      const c = (await db.query(
        'SELECT * FROM clip_pinpad_requests WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
        [l.clip_cobro_id, req.tenant.id],
      )).rows[0];
      if (!c || c.order_id !== o.id || c.status !== 'COMPLETED' || c.used_payment_id) {
        throw badRequest('El cobro de la terminal no esta aprobado para esta orden', 'PINPAD_NOT_APPROVED');
      }
      if (l.kind !== 'tarjeta') throw badRequest('Un cobro de la terminal se registra como pago con tarjeta', 'PINPAD_METHOD');
      if (toCents(c.amount) !== toCents(l.amount) + toCents(l.tip)) {
        throw badRequest('El pago no coincide con lo cobrado en la terminal', 'PINPAD_AMOUNT_MISMATCH');
      }
      l.reference = l.reference || `Clip ${c.card_brand || ''} ****${c.card_last_digits || ''}`.replace(/\s+/g, ' ').trim();
    }
    const remaining = (toCents(o.total) - toCents(o.paid_amount)) / 100;
    if (!lines.length && remaining > 0) throw badRequest('Agrega al menos un pago', 'MISSING_PAYMENTS');
    const norm = normalizePayments(lines, remaining);

    // El codigo del cliente se pide una vez aunque pague con puntos y monedero.
    const verified = new Set();
    for (const [i, p] of norm.lines.entries()) {
      const { rows: [pay] } = await db.query(
        `INSERT INTO order_payments (restaurant_id, order_id, payment_method_id, cash_session_id, amount, tip,
                                     received, change_given, reference, created_by, currency, foreign_received, exchange_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [req.tenant.id, o.id, lines[i].payment_method_id, sessionId, p.amount, p.tip, p.received,
          p.change_given, lines[i].reference, req.user.id, lines[i].currency,
          lines[i].currency === 'USD' ? lines[i].received_usd : null, lines[i].currency === 'USD' ? lines[i].rate : null],
      );
      if (lines[i].redemption) {
        await commitRedemption(db, req.tenant.id, o, lines[i].redemption, { paymentId: pay.id, code: lines[i].loyalty.code, userId: req.user.id, verified });
      }
      if (lines[i].walletPay) {
        await commitWalletPayment(db, req.tenant.id, o, lines[i].walletPay, { paymentId: pay.id, code: lines[i].wallet.code, userId: req.user.id, verified });
      }
      if (lines[i].clip_cobro_id) {
        await db.query('UPDATE clip_pinpad_requests SET used_payment_id = $2 WHERE id = $1', [lines[i].clip_cobro_id, pay.id]);
      }
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
      await deductOrder(db, req.tenant.id, o.id, req.user.id);
      await earnForOrder(db, req.tenant.id, o.id, req.user.id);
      await redeemOrderVoucher(db, req.tenant.id, o.id);
    }
    if (o.order_type === 'domicilio') await afterRegisterPayment(db, req.tenant.id, o.id, paid);
    return {
      order: await loadOrder(db, req.tenant.id, o.id),
      change: norm.change,
      remaining: norm.remaining_after,
    };
  }));
  res.status(201).json(result);
}));

// ---------------------------------------------------------------------------
// Cocina (KDS): ordenes con articulos enviados que aun no se marcan listos.
// ---------------------------------------------------------------------------

// Pantalla de cocina: ordenes con algo enviado y pendiente. Con station_id
// solo lo de esa estacion ("general" = articulos sin estacion). Cada orden
// trae sus articulos enviados; is_new marca los pendientes.
router.get('/kitchen', can('kitchen'), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const raw = req.query.station_id;
  const general = raw === 'general';
  const stationId = raw && !general ? requireUuid(raw, 'station_id') : null;
  const inStation = (alias) => (general ? `AND ${alias}.station_id IS NULL` : stationId ? `AND ${alias}.station_id = $3` : '');
  const orders = await withTenant(req.tenant.id, async (db) => {
    const list = (await db.query(
      `${ORDER_SELECT}
        WHERE o.restaurant_id = $1 AND o.branch_id = $2 AND o.status <> 'cancelada'
          AND o.created_at > now() - interval '24 hours'
          AND EXISTS (SELECT 1 FROM order_items i
                       WHERE i.order_id = o.id AND i.restaurant_id = o.restaurant_id
                         AND i.sent_at IS NOT NULL AND i.voided_at IS NULL AND i.ready_at IS NULL ${inStation('i')})
        ORDER BY o.sent_at, o.created_at`,
      stationId ? [req.tenant.id, branchId, stationId] : [req.tenant.id, branchId],
    )).rows;
    if (!list.length) return [];
    const items = await loadItems(db, req.tenant.id, list.map((o) => o.id));
    const mine = (i) => (general ? !i.station_id : stationId ? i.station_id === stationId : true);
    return list.map((o) => ({
      ...o,
      items: items
        .filter((i) => i.order_id === o.id && i.sent_at && !i.voided_at && mine(i))
        .map((i) => ({ ...i, is_new: !i.ready_at })),
    }));
  });
  res.json({ orders });
}));

export default router;
