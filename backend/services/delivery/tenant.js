// Domicilios del lado del restaurante (fase 5). Reciben un `db` con el
// contexto RLS del restaurante (withTenant, o asTenant dentro de una
// transaccion del Panel o de un repartidor de la flota).
import { HttpError, badRequest, notFound } from '../../utils/http.js';
import { fromCents, normalizePayments, toCents } from '../posMath.js';
import { deductOrder } from '../inventory.js';
import { earnForOrder } from '../loyalty.js';
import {
  ACTIVE_DELIVERY_STATUSES, DELIVERY_STATUS_LABEL, STATUS_TIMESTAMP, assertTransition,
} from './flow.js';

const conflict = (msg, code) => new HttpError(409, msg, code);

/** Configuracion de domicilios del restaurante (la fija el Panel salvo el modo). */
export async function getDeliveryConfig(db, restaurantId) {
  const { rows } = await db.query(
    `SELECT mode, horom_enabled, horom_fee_type, horom_fee_value, updated_at
       FROM delivery_settings WHERE restaurant_id = $1`,
    [restaurantId],
  );
  return rows[0] || {
    mode: 'propio', horom_enabled: false, horom_fee_type: 'fixed', horom_fee_value: '0.00', updated_at: null,
  };
}

/** Bloquea la orden (FOR UPDATE). */
export async function lockOrderRow(db, restaurantId, orderId) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [orderId, restaurantId]);
  if (!rows[0]) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
  return rows[0];
}

/** Un pedido a domicilio puede salir a reparto si ya esta en cocina (o pagado) y aceptado. */
export function assertDispatchable(o) {
  if (o.order_type !== 'domicilio') throw badRequest('Solo los pedidos a domicilio salen a reparto', 'NOT_DELIVERY');
  if (o.status === 'cancelada') throw badRequest('La orden esta cancelada', 'ORDER_CLOSED');
  if (o.source === 'web' && o.online_status !== 'aceptada') {
    throw badRequest('Acepta el pedido en linea antes de continuar', 'ONLINE_ORDER_PENDING');
  }
  if (o.online_payment_status === 'pendiente') {
    throw badRequest('El cliente todavia no completa el pago en linea', 'ONLINE_PAYMENT_PENDING');
  }
  if (o.status === 'abierta') throw badRequest('Envia la orden a cocina antes de mandarla a reparto', 'NOT_SENT');
  if (!o.customer_address) throw badRequest('La orden no tiene direccion de entrega', 'ADDRESS_REQUIRED');
}

/** Reparto vigente (propio o de la flota) de una orden, si lo hay. */
export async function activeDeliveryOf(db, restaurantId, orderId) {
  const own = (await db.query(
    `SELECT id, status FROM order_deliveries
      WHERE restaurant_id = $1 AND order_id = $2 AND status NOT IN ('fallido', 'cancelado')`,
    [restaurantId, orderId],
  )).rows[0];
  if (own) return { kind: 'propio', ...own };
  const req = (await db.query(
    `SELECT id, status FROM delivery_requests
      WHERE restaurant_id = $1 AND order_id = $2 AND status NOT IN ('fallido', 'cancelado')`,
    [restaurantId, orderId],
  )).rows[0];
  return req ? { kind: 'horom', ...req } : null;
}

export async function assertNoActiveDelivery(db, restaurantId, orderId) {
  const d = await activeDeliveryOf(db, restaurantId, orderId);
  if (d) {
    throw conflict(d.status === 'entregado' ? 'El pedido ya se entrego' : 'El pedido ya tiene un reparto en curso', 'DELIVERY_EXISTS');
  }
}

/** Metodo "Efectivo" del restaurante para lo que se cobra en la puerta. */
async function cashMethodId(db, restaurantId) {
  const m = (await db.query(
    `SELECT id FROM payment_methods WHERE restaurant_id = $1 AND kind = 'efectivo'
      ORDER BY active DESC, sort_order, name LIMIT 1`,
    [restaurantId],
  )).rows[0];
  if (!m) throw conflict('El restaurante no tiene un metodo de pago en efectivo', 'CASH_METHOD_REQUIRED');
  return m.id;
}

/**
 * Cobro en la puerta al entregar. Si la cuenta tiene saldo se registra un
 * pago en efectivo por el saldo (con propina y lo recibido para el cambio):
 *  - propio: driverUserId + createdBy, sin turno de caja hasta el corte.
 *  - flota:  deliveryRequestId, sin turno ni usuario (llega en una liquidacion).
 * Despues la orden queda pagada. Regresa { amount, tip } cobrados.
 */
export async function settleAtDoor(db, restaurantId, order, {
  received, tip = 0, createdBy = null, driverUserId = null, deliveryRequestId = null,
} = {}) {
  if (order.status === 'cancelada') throw badRequest('La orden esta cancelada', 'ORDER_CLOSED');
  const remaining = fromCents(toCents(order.total) - toCents(order.paid_amount));
  let amount = 0;
  let tipPaid = 0;
  if (toCents(remaining) > 0) {
    const norm = normalizePayments([{ kind: 'efectivo', amount: remaining, tip, received }], remaining);
    const p = norm.lines[0];
    await db.query(
      `INSERT INTO order_payments (restaurant_id, order_id, payment_method_id, cash_session_id, amount, tip,
                                   received, change_given, reference, created_by, driver_user_id, delivery_request_id)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [restaurantId, order.id, await cashMethodId(db, restaurantId), p.amount, p.tip, p.received, p.change_given,
        deliveryRequestId ? 'Cobrado por la flota' : 'Cobrado por el repartidor', createdBy, driverUserId, deliveryRequestId],
    );
    amount = p.amount;
    tipPaid = p.tip;
  }
  if (['abierta', 'enviada', 'lista'].includes(order.status)) {
    await db.query(
      `UPDATE order_items SET sent_at = now()
        WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NULL AND voided_at IS NULL`,
      [order.id, restaurantId],
    );
    await db.query(
      `UPDATE orders SET paid_amount = paid_amount + $3, tip_amount = tip_amount + $4, status = 'pagada',
              paid_at = now(), sent_at = coalesce(sent_at, now()), dispatched_at = coalesce(dispatched_at, now()),
              updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [order.id, restaurantId, amount, tipPaid],
    );
    await deductOrder(db, restaurantId, order.id);
    await earnForOrder(db, restaurantId, order.id);
  } else {
    await db.query(
      'UPDATE orders SET dispatched_at = coalesce(dispatched_at, now()), updated_at = now() WHERE id = $1 AND restaurant_id = $2',
      [order.id, restaurantId],
    );
  }
  return { amount, tip: tipPaid };
}

/**
 * Efecto de un cambio de estado del reparto sobre la orden (propio o flota):
 * en camino lo ve el cliente; fallido/cancelado lo regresa a "listo";
 * entregado cobra en la puerta y cierra la orden.
 */
export async function syncOrderStatus(db, restaurantId, orderId, to, payOpts = {}) {
  const order = await lockOrderRow(db, restaurantId, orderId);
  if (to === 'en_camino') {
    await db.query(
      'UPDATE orders SET dispatched_at = coalesce(dispatched_at, now()), updated_at = now() WHERE id = $1 AND restaurant_id = $2',
      [orderId, restaurantId],
    );
  } else if (to === 'fallido' || to === 'cancelado') {
    await db.query(
      `UPDATE orders SET dispatched_at = NULL, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2 AND status IN ('abierta', 'enviada', 'lista')`,
      [orderId, restaurantId],
    );
  } else if (to === 'entregado') {
    return settleAtDoor(db, restaurantId, order, payOpts);
  }
  return { amount: 0, tip: 0 };
}

/**
 * Cambio de estado de un reparto propio. opts: { actorId, reason, received, tip }.
 * Regresa la fila actualizada.
 */
export async function applyOwnTransition(db, restaurantId, delivery, to, { actorId, reason = null, received, tip = 0 } = {}) {
  assertTransition(delivery.status, to);
  if (to === 'fallido' && !reason) throw badRequest('Escribe el motivo por el que no se entrego', 'REASON_REQUIRED');
  const paid = await syncOrderStatus(db, restaurantId, delivery.order_id, to, {
    received, tip, createdBy: actorId, driverUserId: delivery.driver_user_id,
  });
  const ts = STATUS_TIMESTAMP[to];
  const { rows } = await db.query(
    `UPDATE order_deliveries SET status = $3, ${ts} = now(), updated_at = now(),
            fail_reason = CASE WHEN $3 = 'fallido' THEN $4 ELSE fail_reason END,
            cancel_reason = CASE WHEN $3 = 'cancelado' THEN $4 ELSE cancel_reason END,
            cash_collected = cash_collected + $5
      WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
    [delivery.id, restaurantId, to, reason, fromCents(toCents(paid.amount) + toCents(paid.tip))],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

const ORDER_COLS = `o.id, o.branch_id, o.folio, o.source, o.status, o.order_type, o.customer_name, o.customer_phone,
  o.customer_address, o.delivery_reference, o.notes, o.subtotal, o.delivery_fee, o.total, o.paid_amount,
  o.payment_preference, o.pay_with, o.online_payment_status, o.ready_at, o.dispatched_at, o.paid_at, o.created_at`;

/** Vista comun de un reparto propio o de la flota. */
export function deliveryView(row, kind) {
  return {
    kind,
    id: row.id,
    order_id: row.order_id,
    status: row.status,
    status_label: DELIVERY_STATUS_LABEL[row.status],
    driver_id: kind === 'propio' ? row.driver_user_id : row.driver_id,
    driver_name: row.driver_name ?? null,
    driver_phone: row.driver_phone ?? null,
    cash_to_collect: row.cash_to_collect,
    cash_collected: row.cash_collected,
    fail_reason: row.fail_reason,
    cancel_reason: row.cancel_reason,
    assigned_at: row.assigned_at,
    picked_up_at: row.picked_up_at,
    on_way_at: row.on_way_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    cancelled_at: row.cancelled_at,
    created_at: row.created_at,
    ...(kind === 'horom' ? { commission_amount: row.commission_amount, notes: row.notes } : {}),
  };
}

/** Repartos (propios y de la flota) de varias ordenes, el mas reciente primero. */
export async function deliveriesOf(db, restaurantId, orderIds) {
  if (!orderIds.length) return new Map();
  const own = (await db.query(
    `SELECT d.*, u.name AS driver_name FROM order_deliveries d
       JOIN users u ON u.id = d.driver_user_id AND u.restaurant_id = d.restaurant_id
      WHERE d.restaurant_id = $1 AND d.order_id = ANY($2::uuid[])`,
    [restaurantId, orderIds],
  )).rows.map((r) => deliveryView(r, 'propio'));
  const fleet = (await db.query(
    `SELECT * FROM delivery_requests WHERE restaurant_id = $1 AND order_id = ANY($2::uuid[])`,
    [restaurantId, orderIds],
  )).rows.map((r) => deliveryView(r, 'horom'));
  const map = new Map(orderIds.map((id) => [id, []]));
  for (const d of [...own, ...fleet]) map.get(d.order_id)?.push(d);
  for (const list of map.values()) list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return map;
}

/**
 * Pedidos a domicilio de una sucursal para la pantalla de reparto: los que
 * siguen activos y los de las ultimas 24 h, con sus repartos.
 * stage: por_asignar | en_reparto | entregado | cerrado.
 */
export async function dispatchOrders(db, restaurantId, branchId) {
  const orders = (await db.query(
    `SELECT ${ORDER_COLS} FROM orders o
      WHERE o.restaurant_id = $1 AND o.branch_id = $2 AND o.order_type = 'domicilio'
        AND o.status <> 'cancelada' AND o.status <> 'abierta'
        AND (o.source <> 'web' OR o.online_status = 'aceptada')
        AND o.online_payment_status IS DISTINCT FROM 'pendiente'
        AND (o.status IN ('enviada', 'lista') OR o.created_at > now() - interval '24 hours')
      ORDER BY o.created_at DESC LIMIT 200`,
    [restaurantId, branchId],
  )).rows;
  const deliveries = await deliveriesOf(db, restaurantId, orders.map((o) => o.id));
  return orders.map((o) => {
    const list = deliveries.get(o.id) || [];
    const current = list.find((d) => !['fallido', 'cancelado'].includes(d.status)) || null;
    let stage;
    if (current?.status === 'entregado') stage = 'entregado';
    else if (current) stage = 'en_reparto';
    else if (o.status === 'pagada' && o.dispatched_at) stage = 'cerrado';
    else stage = 'por_asignar';
    return {
      ...o,
      remaining: fromCents(toCents(o.total) - toCents(o.paid_amount)),
      stage,
      delivery: current,
      history: list.filter((d) => d !== current),
    };
  });
}

/** Repartidores propios de una sucursal con su turno, ubicacion y efectivo por entregar. */
export async function branchDrivers(db, restaurantId, branchId) {
  return (await db.query(
    `SELECT u.id, u.name, u.email,
            coalesce(l.on_duty, false) AS on_duty, l.latitude, l.longitude, l.accuracy_m, l.located_at,
            (SELECT count(*) FROM order_deliveries d
              WHERE d.restaurant_id = u.restaurant_id AND d.driver_user_id = u.id
                AND d.status IN ('asignado', 'recogido', 'en_camino'))::int AS active_count,
            coalesce((SELECT sum(p.amount + p.tip) FROM order_payments p
              WHERE p.restaurant_id = u.restaurant_id AND p.driver_user_id = u.id AND p.driver_cut_id IS NULL), 0)::numeric(10,2)
              AS cash_pending
       FROM users u
       LEFT JOIN driver_locations l ON l.user_id = u.id AND l.restaurant_id = u.restaurant_id
      WHERE u.restaurant_id = $1 AND u.role = 'repartidor' AND u.active
        AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = $2)
      ORDER BY coalesce(l.on_duty, false) DESC, u.name`,
    [restaurantId, branchId],
  )).rows;
}

/** Ubicacion aproximada (~100 m) para el cliente. */
const approx = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 1000);
// Una ubicacion mas vieja que esto ya no se muestra.
const LOCATION_FRESH_MINUTES = 10;

/**
 * Lo que el cliente ve del reparto en su seguimiento: estado, nombre del
 * repartidor y, solo en camino, su ubicacion aproximada.
 */
export async function customerDeliveryView(db, restaurantId, order) {
  if (order.order_type !== 'domicilio') return null;
  const list = (await deliveriesOf(db, restaurantId, [order.id])).get(order.id) || [];
  const d = list.find((x) => x.status !== 'cancelado');
  if (!d) return null;
  let location = null;
  if (d.status === 'en_camino') {
    const row = d.kind === 'propio'
      ? (await db.query(
        `SELECT latitude, longitude, located_at AS at FROM driver_locations
          WHERE restaurant_id = $1 AND user_id = $2 AND on_duty AND latitude IS NOT NULL
            AND located_at > now() - make_interval(mins => $3)`,
        [restaurantId, d.driver_id, LOCATION_FRESH_MINUTES],
      )).rows[0]
      // RLS: el restaurante solo ve la ubicacion de un repartidor de la flota
      // mientras lleva una solicitud suya.
      : (await db.query(
        `SELECT latitude, longitude, updated_at AS at FROM fleet_driver_locations
          WHERE driver_id = $1 AND updated_at > now() - make_interval(mins => $2)`,
        [d.driver_id, LOCATION_FRESH_MINUTES],
      )).rows[0];
    if (row) location = { latitude: approx(row.latitude), longitude: approx(row.longitude), updated_at: row.at };
  }
  return {
    status: d.status,
    status_label: DELIVERY_STATUS_LABEL[d.status],
    // Solo el nombre de pila.
    driver_name: d.driver_name ? String(d.driver_name).split(/\s+/)[0] : null,
    fail_reason: d.status === 'fallido' ? d.fail_reason : null,
    on_way_at: d.on_way_at,
    delivered_at: d.delivered_at,
    location,
  };
}

export { ACTIVE_DELIVERY_STATUSES };
