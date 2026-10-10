// Consultas y reglas compartidas del sitio publico y los pedidos en linea.
// Reciben un `db` que ya viene de withTenant (contexto RLS del restaurante).
import { branchOpenState, hhmm } from './hours.js';

const ONLINE_COLS = `enabled, min_order, prep_time_minutes, auto_accept, allow_pickup, allow_delivery, order_email_alerts,
  schedule_max_days, schedule_min_lead_minutes, schedule_kitchen_minutes, updated_at`;

/** Configuracion de pedidos en linea (se crea con valores por defecto si falta). */
export async function getOnlineSettings(db, restaurantId) {
  await db.query('INSERT INTO online_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [restaurantId]);
  return (await db.query(`SELECT ${ONLINE_COLS} FROM online_settings WHERE restaurant_id = $1`, [restaurantId])).rows[0];
}

/**
 * Sucursales con su horario, dias cerrados proximos, estado abierto/cerrado
 * y configuracion de pedidos en linea. onlyActive = solo las activas.
 */
export async function loadBranches(db, restaurantId, { onlyActive = true, now = new Date() } = {}) {
  const branches = (await db.query(
    `SELECT b.id, b.name, b.address, b.phone, b.timezone, b.active,
            coalesce(s.online_enabled, true) AS online_enabled,
            coalesce(s.delivery_enabled, true) AS delivery_enabled,
            coalesce(s.delivery_fee, 0) AS delivery_fee
       FROM branches b
       LEFT JOIN branch_online_settings s ON s.branch_id = b.id AND s.restaurant_id = b.restaurant_id
      WHERE b.restaurant_id = $1 ${onlyActive ? 'AND b.active' : ''}
      ORDER BY b.name`,
    [restaurantId],
  )).rows;
  if (!branches.length) return [];
  const ids = branches.map((b) => b.id);
  const hours = (await db.query(
    `SELECT branch_id, weekday, to_char(opens_at, 'HH24:MI') AS opens_at, to_char(closes_at, 'HH24:MI') AS closes_at
       FROM branch_hours WHERE restaurant_id = $1 AND branch_id = ANY($2::uuid[]) ORDER BY weekday`,
    [restaurantId, ids],
  )).rows;
  // Desde ayer: el turno nocturno de ayer tambien depende de los cierres.
  const closures = (await db.query(
    `SELECT branch_id, to_char(closed_on, 'YYYY-MM-DD') AS closed_on, reason
       FROM branch_closures
      WHERE restaurant_id = $1 AND branch_id = ANY($2::uuid[]) AND closed_on >= current_date - 1
      ORDER BY closed_on`,
    [restaurantId, ids],
  )).rows;
  return branches.map((b) => {
    const h = hours.filter((x) => x.branch_id === b.id).map(({ weekday, opens_at, closes_at }) => ({ weekday, opens_at, closes_at }));
    const c = closures.filter((x) => x.branch_id === b.id).map(({ closed_on, reason }) => ({ closed_on, reason }));
    return {
      ...b,
      hours: h,
      closures: c,
      maps_url: mapsUrl(b.address),
      status: branchOpenState({ hours: h, closures: c.map((x) => x.closed_on), timezone: b.timezone }, now),
    };
  });
}

export const mapsUrl = (address) => (address
  ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
  : null);

/** Vista publica de una sucursal (sin campos internos). */
export function publicBranch(b) {
  return {
    id: b.id,
    name: b.name,
    address: b.address,
    phone: b.phone,
    timezone: b.timezone,
    maps_url: b.maps_url,
    hours: b.hours.map((h) => ({ ...h, opens_at: hhmm(h.opens_at), closes_at: hhmm(h.closes_at) })),
    closures: b.closures,
    open_now: b.status.open,
    today: b.status.today,
    closed_today: b.status.closed_today,
  };
}

// ---------------------------------------------------------------------------
// Estado del pedido para el cliente
// ---------------------------------------------------------------------------

export const CUSTOMER_STATUS_LABEL = {
  esperando_pago: 'Esperando tu pago en línea',
  recibido: 'Recibido, esperando confirmación',
  programado: 'Programado',
  preparando: 'En preparación',
  listo: 'Listo para recoger',
  en_camino: 'En camino',
  entregado: 'Entregado',
  rechazado: 'Rechazado',
  cancelado: 'Cancelado',
};

/** Estado simplificado que ve el cliente, derivado de status y online_status. */
export function customerStatus(o) {
  if (o.status === 'cancelada') return o.online_status === 'rechazada' ? 'rechazado' : 'cancelado';
  if (o.status === 'pagada') return 'entregado';
  if (o.online_payment_status === 'pendiente') return 'esperando_pago';
  if (o.online_status === 'pendiente') return 'recibido';
  // Programado y aceptado: entra a cocina sola antes de la hora.
  if (o.scheduled_for && !o.sent_at && o.status === 'abierta') return 'programado';
  if (o.status === 'lista') return o.order_type === 'domicilio' && o.dispatched_at ? 'en_camino' : 'listo';
  if (o.order_type === 'domicilio' && o.dispatched_at) return 'en_camino';
  return 'preparando';
}

/** Lo que el cliente puede ver de su pedido (sin datos internos del POS). */
export function customerOrderView(o, branch = null) {
  const status = customerStatus(o);
  const label = status === 'listo' && o.order_type === 'domicilio' ? 'Listo, saliendo pronto' : CUSTOMER_STATUS_LABEL[status];
  return {
    id: o.id,
    token: o.public_token,
    folio: o.folio,
    branch: branch ? { id: branch.id, name: branch.name, address: branch.address, phone: branch.phone } : { id: o.branch_id },
    order_type: o.order_type,
    status,
    status_label: label,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    customer_address: o.customer_address,
    delivery_reference: o.delivery_reference,
    notes: o.notes,
    payment_preference: o.payment_preference,
    pay_with: o.pay_with,
    // Pago en linea (Clip): pendiente, pagado o cancelado; null = pago al recibir.
    payment_provider: o.payment_provider,
    online_payment_status: o.online_payment_status ?? null,
    payment_due_at: o.online_payment_status === 'pendiente' ? o.payment_due_at : null,
    items: (o.items || []).filter((i) => !i.voided_at).map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit_price: i.unit_price,
      modifiers_total: i.modifiers_total,
      line_total: i.line_total,
      notes: i.notes,
      modifiers: (i.modifiers || []).map((m) => ({ group_name: m.group_name, name: m.name, price_delta: m.price_delta })),
    })),
    subtotal: o.subtotal,
    discount_amount: o.discount_amount,
    tax_amount: o.tax_amount,
    tax_rate_pct: o.tax_rate_pct,
    prices_include_tax: o.prices_include_tax,
    delivery_fee: o.delivery_fee,
    total: o.total,
    paid: o.status === 'pagada' || o.online_payment_status === 'pagado',
    cancel_reason: o.status === 'cancelada' ? o.cancel_reason : null,
    created_at: o.created_at,
    accepted_at: o.accepted_at,
    estimated_ready_at: o.estimated_ready_at,
    scheduled_for: o.scheduled_for ?? null,
    ready_at: o.ready_at,
    dispatched_at: o.dispatched_at,
    paid_at: o.paid_at,
  };
}

/**
 * Acepta un pedido en linea: lo manda a cocina y fija la hora estimada.
 * userId NULL cuando se acepta solo (auto_accept).
 */
export async function acceptOnlineOrder(db, restaurantId, orderId, { userId = null, prepMinutes }) {
  // Programado para mas tarde: se acepta pero entra a cocina hasta su hora
  // (services/scheduling.js releaseScheduledOrders).
  const sched = (await db.query(
    `SELECT o.scheduled_for,
            o.scheduled_for - make_interval(mins => coalesce(s.schedule_kitchen_minutes, 45)) > now() AS hold
       FROM orders o LEFT JOIN online_settings s ON s.restaurant_id = o.restaurant_id
      WHERE o.id = $1 AND o.restaurant_id = $2`,
    [orderId, restaurantId],
  )).rows[0];
  if (sched?.hold) {
    await db.query(
      `UPDATE orders SET online_status = 'aceptada', accepted_at = now(), accepted_by = $3,
              estimated_ready_at = scheduled_for, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [orderId, restaurantId, userId],
    );
    return;
  }
  await db.query(
    `UPDATE order_items SET sent_at = now()
      WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NULL AND voided_at IS NULL`,
    [orderId, restaurantId],
  );
  await db.query(
    `UPDATE orders SET online_status = 'aceptada', accepted_at = now(), accepted_by = $3,
            status = CASE WHEN status = 'abierta' THEN 'enviada' ELSE status END,
            sent_at = coalesce(sent_at, now()),
            estimated_ready_at = greatest(scheduled_for, now() + make_interval(mins => $4::int)), updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [orderId, restaurantId, userId, prepMinutes],
  );
}
