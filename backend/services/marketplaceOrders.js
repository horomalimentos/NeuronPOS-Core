// NeuronPOS Delivery (fase 2): restaurantes cercanos, menu, cotizacion y
// alta del pedido del cliente.
//
// Un restaurante se puede pedir si su ficha esta publicada (sin bloqueo ni
// pausa), el restaurante tiene el modulo vigente, la sucursal esta abierta,
// la distancia cabe en la tabla de envio y hay al menos un repartidor
// aprobado y en turno cuyo radio cubre al restaurante (como en Horom: sin
// repartidores conectados no se puede pedir).
//
// El pedido se guarda en el restaurante (orders, canal 'marketplace', a
// domicilio, en linea pendiente de aceptar) solo con la comida: el envio no
// es del restaurante. La parte de plataforma va en marketplace_orders
// (envio, reparto 80/20, total del cliente, token de seguimiento).
// Con tarjeta el pedido nace 'pago_pendiente' (el restaurante no lo ve)
// hasta que Clip confirma el pago (services/marketplaceMoney.js).
// Precios: siempre los del menu en el servidor.
import crypto from 'node:crypto';
import { withPlatform, withTenant } from '../config/database.js';
import { insertItems, nextFolio, priceItems, readItemInputs, recalcOrder } from '../routes/pos/orders.js';
import { getSettings } from '../routes/pos/settings.js';
import { HttpError, badRequest, notFound, oneOf, requireUuid, str } from '../utils/http.js';
import { checkModuleAccess } from './access.js';
import { cancelUnpaidOrder, cardPaymentsAvailable, createOrderCheckout } from './marketplaceMoney.js';
import { haversineKm, readPoint } from './deliveryZones.js';
import { branchOpenState } from './hours.js';
import {
  driverCovers, feeForDistance, getMarketplaceSettings, listFeeTiers, splitDeliveryFee,
} from './marketplace.js';
import { readPhone } from './onlineOrders.js';
import { calculateOrderTotals, toCents } from './posMath.js';

const conflict = (msg, code) => new HttpError(409, msg, code);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Fichas visibles con todo lo necesario para decidir si se puede pedir.
 * Corre como plataforma (lee varios restaurantes y a los repartidores).
 */
async function loadCandidates(db, { branchId = null } = {}) {
  const { rows } = await db.query(
    `SELECT l.restaurant_id, l.branch_id, l.latitude, l.longitude, l.description, l.cuisine, l.cover_url,
            l.prep_minutes, l.min_order,
            r.id, r.name AS restaurant_name, r.slug, r.logo_url, r.primary_color, r.status, r.trial_ends_at, r.suspended_reason,
            b.name AS branch_name, b.address, b.timezone,
            rm.enabled, rm.started_at, rm.ends_at
       FROM marketplace_listings l
       JOIN restaurants r ON r.id = l.restaurant_id
       JOIN branches b ON b.id = l.branch_id AND b.active
       LEFT JOIN restaurant_modules rm ON rm.restaurant_id = l.restaurant_id AND rm.module_code = 'marketplace'
      WHERE l.published AND NOT l.blocked AND (l.paused_until IS NULL OR l.paused_until <= now())
        AND ($1::uuid IS NULL OR l.branch_id = $1)`,
    [branchId],
  );
  const ok = rows.filter((r) => !checkModuleAccess(r, 'marketplace', r));
  if (!ok.length) return [];
  const ids = ok.map((r) => r.branch_id);
  const hours = (await db.query(
    `SELECT branch_id, weekday, to_char(opens_at, 'HH24:MI') AS opens_at, to_char(closes_at, 'HH24:MI') AS closes_at
       FROM branch_hours WHERE branch_id = ANY($1::uuid[])`,
    [ids],
  )).rows;
  const closures = (await db.query(
    `SELECT branch_id, to_char(closed_on, 'YYYY-MM-DD') AS closed_on FROM branch_closures
      WHERE branch_id = ANY($1::uuid[]) AND closed_on >= current_date - 1`,
    [ids],
  )).rows;
  const now = new Date();
  return ok.map((r) => {
    const h = hours.filter((x) => x.branch_id === r.branch_id);
    const c = closures.filter((x) => x.branch_id === r.branch_id).map((x) => x.closed_on);
    return { ...r, point: { latitude: Number(r.latitude), longitude: Number(r.longitude) }, open: branchOpenState({ hours: h, closures: c, timezone: r.timezone }, now) };
  });
}

async function onlineDrivers(db) {
  return (await db.query(
    `SELECT id, base_latitude, base_longitude, radius_km FROM fleet_drivers
      WHERE active AND status = 'aprobado' AND on_duty AND base_latitude IS NOT NULL AND radius_km IS NOT NULL`,
  )).rows;
}

/** Que ve el cliente de un restaurante desde su punto. */
function evaluate(c, point, { settings, tiers, drivers }) {
  const distance = round2(haversineKm(c.point, point));
  const fee = feeForDistance(tiers, distance, Number(settings.max_distance_km));
  const hasDriver = drivers.some((d) => driverCovers(d, c.point));
  let reason = null;
  if (fee === null) reason = 'lejos';
  else if (!c.open.open) reason = 'cerrado';
  else if (!hasDriver) reason = 'sin_repartidor';
  return {
    branch_id: c.branch_id,
    restaurant_id: c.restaurant_id,
    name: c.restaurant_name,
    branch_name: c.branch_name,
    logo_url: c.logo_url,
    primary_color: c.primary_color,
    cuisine: c.cuisine,
    description: c.description,
    cover_url: c.cover_url,
    address: c.address,
    prep_minutes: c.prep_minutes,
    min_order: Number(c.min_order),
    distance_km: distance,
    delivery_fee: fee,
    open: c.open.open,
    today: c.open.today,
    has_driver: hasDriver,
    can_order: reason === null,
    reason,
  };
}

async function context(db) {
  const settings = await getMarketplaceSettings(db);
  if (!settings.enabled) throw conflict('NeuronPOS Delivery no esta recibiendo pedidos por ahora', 'MARKETPLACE_DISABLED');
  return { settings, tiers: await listFeeTiers(db), drivers: await onlineDrivers(db) };
}

/** Restaurantes a la distancia maxima del cliente, los que se pueden pedir primero. */
export async function nearbyRestaurants(point) {
  return withPlatform(async (db) => {
    const ctx = await context(db);
    const list = (await loadCandidates(db))
      .map((c) => evaluate(c, point, ctx))
      .filter((r) => r.delivery_fee !== null);
    list.sort((a, b) => Number(b.can_order) - Number(a.can_order) || a.distance_km - b.distance_km);
    return { restaurants: list, drivers_online: ctx.drivers.length };
  });
}

/** Un restaurante desde el punto del cliente (404 si no esta publicado). */
export async function restaurantFor(branchId, point) {
  return withPlatform(async (db) => {
    const ctx = await context(db);
    const [c] = await loadCandidates(db, { branchId });
    if (!c) throw notFound('Este restaurante no esta disponible en NeuronPOS Delivery', 'LISTING_NOT_FOUND');
    return point ? evaluate(c, point, ctx) : { ...evaluate(c, c.point, ctx), distance_km: null, delivery_fee: null, can_order: false, reason: 'sin_ubicacion' };
  });
}

const REASON_ERROR = {
  lejos: ['Este restaurante no entrega hasta tu domicilio', 'OUT_OF_RANGE'],
  cerrado: ['El restaurante esta cerrado en este momento', 'BRANCH_CLOSED'],
  sin_repartidor: ['No hay repartidores conectados en esta zona en este momento. Intenta en unos minutos.', 'NO_DRIVERS'],
};

/** Lee lo que manda el cliente. quote: sin datos de contacto. */
export function readMarketplaceOrder(body = {}, { quote = false } = {}) {
  const c = body.customer || {};
  const a = body.address || {};
  const input = {
    branch_id: requireUuid(body.branch_id, 'branch_id'),
    items: readItemInputs(body.items),
    location: readPoint(body.location),
    name: str(c.name, { field: 'name', max: 120 }) || null,
    phone: readPhone(c.phone) || null,
    address: str(a.address, { field: 'address', max: 400 }) || null,
    reference: str(a.reference, { field: 'reference', max: 200 }) || null,
    notes: str(body.notes, { field: 'notes', max: 500 }) || null,
    payment_method: oneOf(body.payment_method ?? 'efectivo', ['efectivo', 'tarjeta'], 'payment_method'),
    pay_with: body.pay_with === undefined || body.pay_with === null || body.pay_with === '' ? null : Number(body.pay_with),
  };
  if (!input.location) throw badRequest('Marca tu domicilio en el mapa', 'LOCATION_REQUIRED');
  if (input.payment_method === 'tarjeta') {
    if (!cardPaymentsAvailable()) throw badRequest('Por ahora NeuronPOS Delivery solo recibe pago en efectivo', 'PAYMENT_UNAVAILABLE');
    input.pay_with = null;
  }
  if (input.pay_with !== null && (!Number.isFinite(input.pay_with) || input.pay_with < 0 || input.pay_with > 100000)) {
    throw badRequest('Indica con cuanto vas a pagar', 'INVALID_FIELD');
  }
  if (!quote) {
    if (!input.name) throw badRequest('Escribe tu nombre', 'CUSTOMER_REQUIRED');
    if (!input.phone) throw badRequest('Escribe tu telefono para avisarte de tu pedido', 'CUSTOMER_REQUIRED');
    if (!input.address) throw badRequest('Escribe la direccion de entrega', 'ADDRESS_REQUIRED');
  }
  return input;
}

/** Valua el pedido en el restaurante (menu, minimo, envio de la tabla). */
async function price(db, place, input) {
  const rid = place.restaurant_id;
  const hidden = await db.query(
    `SELECT 1 FROM menu_items i JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.id = ANY($2::uuid[]) AND NOT c.active LIMIT 1`,
    [rid, input.items.map((i) => i.menu_item_id)],
  );
  if (hidden.rowCount) throw badRequest('Algun producto ya no esta disponible', 'ITEM_NOT_FOUND');
  const lines = await priceItems(db, rid, place.branch_id, input.items);
  const subtotalCents = lines.reduce((s, l) => s + toCents(l.line_total), 0);
  if (subtotalCents < toCents(place.min_order)) {
    throw badRequest(`El pedido minimo en ${place.name} es de $${place.min_order.toFixed(2)}`, 'BELOW_MIN_ORDER');
  }
  const pos = await getSettings(db, rid);
  // La orden del restaurante: solo comida. El cliente paga comida + envio.
  const food = calculateOrderTotals(lines, { taxRatePct: pos.tax_rate_pct, pricesIncludeTax: pos.prices_include_tax });
  const fee = toCents(place.delivery_fee);
  const totals = { ...food, delivery_fee: fee / 100, total: (toCents(food.total) + fee) / 100 };
  if (input.pay_with !== null && toCents(input.pay_with) < toCents(totals.total)) {
    throw badRequest('El efectivo con el que pagas no alcanza para el total', 'PAY_WITH_TOO_LOW');
  }
  return { lines, pos, totals };
}

async function placeFor(input) {
  const place = await restaurantFor(input.branch_id, input.location);
  if (!place.can_order) {
    const [msg, code] = REASON_ERROR[place.reason] || ['No se puede pedir a este restaurante', 'NOT_AVAILABLE'];
    throw conflict(msg, code);
  }
  return place;
}

export async function quoteMarketplaceOrder(input) {
  const place = await placeFor(input);
  const { lines, totals } = await withTenant(place.restaurant_id, (db) => price(db, place, input));
  return { restaurant: place, lines, totals };
}

/**
 * Crea el pedido. Regresa la vista de seguimiento; con tarjeta, ademas
 * payment_url (liga de Clip de NeuronPOS).
 */
export async function createMarketplaceOrder(input) {
  const place = await placeFor(input);
  const share = Number((await withPlatform(getMarketplaceSettings)).driver_share_pct);
  const rid = place.restaurant_id;
  const card = input.payment_method === 'tarjeta';
  const token = crypto.randomBytes(18).toString('base64url');
  // Id generado aqui: el restaurante no puede leer (RETURNING) un pedido 'pago_pendiente'.
  const marketplaceOrderId = crypto.randomUUID();
  await withTenant(rid, async (db) => {
    const { lines, pos, totals } = await price(db, place, input);
    const folio = await nextFolio(db, rid, place.branch_id);
    const { rows } = await db.query(
      `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, source, channel, online_status,
                           customer_name, customer_phone, customer_address, delivery_reference, notes,
                           tax_rate_pct, prices_include_tax, delivery_fee, payment_provider, payment_preference, pay_with,
                           public_token, delivery_latitude, delivery_longitude, delivery_distance_km, online_payment_status)
       VALUES ($1, $2, $3, 'domicilio', 'web', 'marketplace', 'pendiente', $4, $5, $6, $7, $8, $9, $10, 0,
               'contra_entrega', 'efectivo', $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [rid, place.branch_id, folio, input.name, input.phone, input.address, input.reference, input.notes,
        pos.tax_rate_pct, pos.prices_include_tax, null, token,
        input.location.latitude, input.location.longitude, place.distance_km, card ? 'pendiente' : null],
    );
    const order = rows[0];
    await insertItems(db, rid, order.id, null, lines);
    const final = await recalcOrder(db, rid, order);
    const fee = Number(totals.delivery_fee);
    const split = splitDeliveryFee(fee, share);
    await db.query(
      `INSERT INTO marketplace_orders (id, restaurant_id, branch_id, order_id, public_token, customer_name, customer_phone,
                                       address, reference, latitude, longitude, distance_km, delivery_fee, driver_share,
                                       platform_share, food_total, total, payment_method, pay_with, status)
       VALUES ($20, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [rid, place.branch_id, order.id, token, input.name, input.phone, input.address, input.reference,
        input.location.latitude, input.location.longitude, place.distance_km, fee, split.driver, split.platform,
        final.total, round2(Number(final.total) + fee), input.payment_method, input.pay_with, card ? 'pago_pendiente' : 'nuevo', marketplaceOrderId],
    );
  });
  if (!card) return trackOrder(token);
  try {
    const link = await createOrderCheckout(marketplaceOrderId);
    return { ...(await trackOrder(token)), payment_url: link.payment_url };
  } catch (err) {
    // Sin liga no hay pedido: se cancela para que no quede colgado.
    await withPlatform((db) => cancelUnpaidOrder(db, marketplaceOrderId, 'No se pudo generar el pago con tarjeta'));
    throw err;
  }
}

export const MARKETPLACE_STATUS_LABEL = {
  pago_pendiente: 'Esperando tu pago con tarjeta',
  nuevo: 'Esperando al restaurante',
  aceptado: 'En preparación',
  listo: 'Listo, esperando al repartidor',
  en_camino: 'En camino',
  entregado: 'Entregado',
  rechazado: 'El restaurante no pudo aceptarlo',
  cancelado: 'Cancelado',
};

/** Seguimiento publico por token (sin datos de otros pedidos). */
export async function trackOrder(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 64) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  const data = await withPlatform(async (db) => {
    const m = (await db.query(
      `SELECT m.*, r.name AS restaurant_name, r.logo_url, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone,
              o.folio, o.estimated_ready_at, l.prep_minutes
         FROM marketplace_orders m
         JOIN restaurants r ON r.id = m.restaurant_id
         JOIN branches b ON b.id = m.branch_id
         JOIN orders o ON o.id = m.order_id
         LEFT JOIN marketplace_listings l ON l.branch_id = m.branch_id
        WHERE m.public_token = $1`,
      [token],
    )).rows[0];
    if (!m) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
    const items = (await db.query(
      `SELECT name, quantity, unit_price, modifiers_total, notes,
              (SELECT coalesce(json_agg(x.name ORDER BY x.name), '[]') FROM order_item_modifiers x WHERE x.order_item_id = i.id) AS modifiers
         FROM order_items i WHERE i.order_id = $1 AND i.voided_at IS NULL ORDER BY i.created_at`,
      [m.order_id],
    )).rows;
    return { m, items };
  });
  const { m, items } = data;
  return {
    token: m.public_token,
    folio: m.folio,
    status: m.status,
    status_label: MARKETPLACE_STATUS_LABEL[m.status],
    cancel_reason: m.cancel_reason,
    restaurant: { name: m.restaurant_name, logo_url: m.logo_url, branch_name: m.branch_name, address: m.branch_address, phone: m.branch_phone },
    customer_name: m.customer_name,
    address: m.address,
    reference: m.reference,
    items: items.map((i) => ({ ...i, line_total: round2((Number(i.unit_price) + Number(i.modifiers_total)) * i.quantity) })),
    food_total: m.food_total,
    delivery_fee: m.delivery_fee,
    total: m.total,
    payment_method: m.payment_method,
    pay_with: m.pay_with,
    estimated_ready_at: m.estimated_ready_at,
    created_at: m.created_at,
    accepted_at: m.accepted_at,
    ready_at: m.ready_at,
    picked_up_at: m.picked_up_at,
    delivered_at: m.delivered_at,
    cancelled_at: m.cancelled_at,
  };
}
