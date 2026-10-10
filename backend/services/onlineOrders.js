// Pedidos en linea: validacion, cotizacion y alta. Lo usan el portal
// (sitio del restaurante) y el bot de WhatsApp, con las mismas reglas.
//
// Precios: el cliente solo manda productos, cantidades, modificadores y
// notas. El servidor valua todo con las mismas reglas del POS (priceItems y
// posMath); cualquier precio que mande el cliente se ignora.
import crypto from 'node:crypto';
import { withTenant } from '../config/database.js';
import { loadModuleRow } from '../middleware/requireModule.js';
import { insertItems, loadOrder, nextFolio, priceItems, readItemInputs, recalcOrder } from '../routes/pos/orders.js';
import { getSettings } from '../routes/pos/settings.js';
import { HttpError, badRequest, notFound, oneOf, requireUuid, str } from '../utils/http.js';
import { checkModuleAccess } from './access.js';
import { loadZones, quoteZone, readPoint } from './deliveryZones.js';
import { alertNewOnlineOrder } from './emails.js';
import { acceptOnlineOrder, customerOrderView, getOnlineSettings, loadBranches } from './online.js';
import { DEFAULT_PROVIDER, getPaymentProvider } from './onlinePayments.js';
import { calculateOrderTotals, toCents } from './posMath.js';
import { getPaymentSettings, loadRestaurantClipCredentials, onlinePaymentAvailable } from './restaurantPayments.js';
import { readScheduledFor } from './scheduling.js';
import { activeWallet } from './wallet.js';

const conflict = (msg, code) => new HttpError(409, msg, code);

/** Pago de pedidos con monedero: modulo vigente y encendido en sus ajustes. */
export async function walletPayAvailable(db, restaurantId) {
  return Boolean((await activeWallet(db, restaurantId))?.web_enabled);
}

/** Modulos que el portal necesita ademas de si mismo. */
export async function moduleState(tenant) {
  const [pos, domicilios, zonas, programados] = await Promise.all(
    ['pos', 'domicilios', 'zonas_entrega', 'pedidos_programados'].map((c) => loadModuleRow(tenant.id, c)),
  );
  return {
    pos: !checkModuleAccess(tenant, 'pos', pos),
    domicilios: checkModuleAccess(tenant, 'domicilios', domicilios),
    zonas: !checkModuleAccess(tenant, 'zonas_entrega', zonas),
    programados: !checkModuleAccess(tenant, 'pedidos_programados', programados),
  };
}

export function readPhone(value, { required = false } = {}) {
  const v = str(value, { field: 'phone', required, max: 30 });
  if (v && (v.replace(/\D/g, '').length < 7 || !/^[+0-9 ()-]+$/.test(v))) {
    throw badRequest('Escribe un telefono valido (al menos 7 digitos)', 'INVALID_PHONE');
  }
  return v;
}

/** Lee y valida lo que manda el cliente (sin tocar la BD). */
export function readOrderInput(body = {}, customer, { quote = false } = {}) {
  const orderType = oneOf(body.order_type, ['para_llevar', 'domicilio'], 'order_type');
  if (!orderType) throw badRequest('Elige si recoges en sucursal o a domicilio', 'MISSING_FIELD');
  const c = body.customer || {};
  const input = {
    branch_id: requireUuid(body.branch_id, 'branch_id'),
    order_type: orderType,
    items: readItemInputs(body.items),
    name: str(c.name, { field: 'name', max: 120 }) || customer?.name || null,
    phone: readPhone(c.phone) || customer?.phone || null,
    notes: str(body.notes, { field: 'notes', max: 500 }) || null,
    address_id: body.address_id ? requireUuid(body.address_id, 'address_id') : null,
    address: null,
    reference: null,
    save_address: body.save_address === true,
    payment: body.payment || {},
    // Pin del domicilio en el mapa (zonas de entrega).
    location: readPoint(body.location),
    // Para mas tarde: uno de los horarios de GET /portal/schedule (ISO).
    scheduled_for: body.scheduled_for ? String(body.scheduled_for).slice(0, 40) : null,
  };
  // La cotizacion no necesita datos de contacto ni direccion (el envio es por sucursal).
  if (!input.name && !quote) throw badRequest('Escribe tu nombre', 'CUSTOMER_REQUIRED');
  if (!input.phone && !quote) throw badRequest('Escribe tu telefono para avisarte de tu pedido', 'CUSTOMER_REQUIRED');
  if (orderType === 'domicilio' && !input.address_id) {
    const a = body.address || {};
    input.address = str(a.address, { field: 'address', max: 400 }) || null;
    input.reference = str(a.reference, { field: 'reference', max: 200 }) || null;
    if (!input.address && !quote) throw badRequest('Escribe la direccion de entrega', 'ADDRESS_REQUIRED');
  }
  if (input.address_id && !customer) throw badRequest('Inicia sesion para usar tus direcciones guardadas', 'ADDRESS_NOT_FOUND');
  return input;
}

/**
 * Valida el pedido contra la configuracion, la sucursal (abierta) y el menu,
 * y lo valua del lado del servidor. Se usa para cotizar y para crear.
 */
export async function prepareOrder(db, req, input, mods, { quote = false } = {}) {
  const rid = req.tenant.id;
  const settings = await getOnlineSettings(db, rid);
  if (!settings.enabled || !mods.pos) throw conflict('Este restaurante no esta recibiendo pedidos en linea', 'ONLINE_ORDERS_DISABLED');
  if (input.order_type === 'para_llevar' && !settings.allow_pickup) {
    throw badRequest('Este restaurante no recibe pedidos para recoger', 'ORDER_TYPE_UNAVAILABLE');
  }
  if (input.order_type === 'domicilio' && !settings.allow_delivery) {
    throw badRequest('Este restaurante no recibe pedidos a domicilio', 'ORDER_TYPE_UNAVAILABLE');
  }

  const branch = (await loadBranches(db, rid)).find((b) => b.id === input.branch_id);
  if (!branch) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
  if (!branch.online_enabled) throw conflict('Esta sucursal no recibe pedidos en linea', 'BRANCH_NOT_ACCEPTING');
  if (input.order_type === 'domicilio' && !branch.delivery_enabled) {
    throw badRequest('Esta sucursal no entrega a domicilio', 'ORDER_TYPE_UNAVAILABLE');
  }
  let scheduledFor = null;
  if (input.scheduled_for) {
    if (!mods.programados) throw badRequest('Este restaurante no recibe pedidos programados', 'SCHEDULING_UNAVAILABLE');
    scheduledFor = readScheduledFor(input.scheduled_for, branch, settings);
  } else if (!branch.status.open) {
    throw conflict(`${branch.name} esta cerrada en este momento. Intenta en su horario de atencion.`, 'BRANCH_CLOSED');
  }

  // Productos de categorias desactivadas no se venden en linea.
  const hidden = await db.query(
    `SELECT 1 FROM menu_items i JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.id = ANY($2::uuid[]) AND NOT c.active LIMIT 1`,
    [rid, input.items.map((i) => i.menu_item_id)],
  );
  if (hidden.rowCount) throw badRequest('Algun producto ya no esta disponible', 'ITEM_NOT_FOUND');
  const lines = await priceItems(db, rid, branch.id, input.items);

  const subtotalCents = lines.reduce((s, l) => s + toCents(l.line_total), 0);
  if (subtotalCents < toCents(settings.min_order)) {
    throw badRequest(`El pedido minimo es de $${Number(settings.min_order).toFixed(2)}`, 'BELOW_MIN_ORDER');
  }

  let address = input.address;
  let reference = input.reference;
  let point = input.location;
  if (input.order_type === 'domicilio' && input.address_id) {
    const a = (await db.query(
      'SELECT address, reference, latitude, longitude FROM customer_addresses WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3',
      [input.address_id, rid, req.customer.id],
    )).rows[0];
    if (!a) throw notFound('Direccion no encontrada', 'ADDRESS_NOT_FOUND');
    address = a.address;
    reference = a.reference;
    if (!point && a.latitude !== null) point = { latitude: Number(a.latitude), longitude: Number(a.longitude) };
  }

  // Zona de entrega: tarifa por distancia y domicilio dentro de la zona.
  let deliveryFee = input.order_type === 'domicilio' ? branch.delivery_fee : 0;
  let distanceKm = null;
  const zone = input.order_type === 'domicilio' && mods.zonas ? (await loadZones(db, rid)).get(branch.id) : null;
  if (zone) {
    if (point) {
      const z = quoteZone(zone, point);
      deliveryFee = z.fee;
      distanceKm = z.distance_km;
    } else if (quote) {
      deliveryFee = zone.tiers[0].fee;
    } else {
      throw badRequest('Marca tu domicilio en el mapa para calcular el envío', 'LOCATION_REQUIRED');
    }
    if (subtotalCents < toCents(zone.min_order)) {
      throw badRequest(`El pedido mínimo a domicilio en esta sucursal es de $${zone.min_order.toFixed(2)}`, 'BELOW_MIN_ORDER');
    }
  } else {
    point = null;
  }

  const pos = await getSettings(db, rid);
  const totals = calculateOrderTotals(lines, {
    taxRatePct: pos.tax_rate_pct, pricesIncludeTax: pos.prices_include_tax, deliveryFee,
  });
  const clipAvailable = onlinePaymentAvailable(await getPaymentSettings(db, rid));
  const walletAvailable = input.payment.provider === 'monedero' && await walletPayAvailable(db, rid);
  const provider = getPaymentProvider(input.payment.provider || DEFAULT_PROVIDER, { clipAvailable, walletAvailable });
  if (provider.needsCustomer && !req.customer) {
    throw badRequest('Inicia sesión para pagar con tu monedero', 'LOGIN_REQUIRED');
  }
  const payment = provider.validate(input.payment, { total: totals.total });
  return { settings, branch, lines, totals, pos, provider, payment, address, reference, point, distanceKm, zone, scheduledFor };
}

export async function readMods(tenant, input) {
  const mods = await moduleState(tenant);
  if (input.order_type === 'domicilio' && mods.domicilios) {
    const { status, ...body } = mods.domicilios;
    throw new HttpError(status, body.error, body.code, { module: body.module });
  }
  return mods;
}

/**
 * Crea un pedido en linea (sitio o bot de WhatsApp). req = { tenant, customer }.
 * channel: por donde llego ('web' o 'whatsapp'). Devuelve { order, payment, full }.
 */
export async function createOnlineOrder(req, input, { channel = 'web' } = {}) {
  const mods = await readMods(req.tenant, input);
  const rid = req.tenant.id;
  // Pago en linea: credenciales del restaurante (se descifran fuera de la transaccion).
  const creds = input.payment.provider === 'clip' ? await loadRestaurantClipCredentials(rid) : null;
  const result = await withTenant(rid, async (db) => {
    const p = await prepareOrder(db, req, input, mods);
    const online = p.provider.online;
    const timeout = online ? (await getPaymentSettings(db, rid)).payment_timeout_minutes : null;
    const folio = await nextFolio(db, rid, p.branch.id);
    const token = crypto.randomBytes(18).toString('base64url');
    const { rows } = await db.query(
      `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, source, channel, online_status, customer_id,
                           customer_name, customer_phone, customer_address, delivery_reference, notes,
                           tax_rate_pct, prices_include_tax, delivery_fee, payment_provider,
                           payment_preference, pay_with, public_token, online_payment_status, payment_due_at,
                           delivery_latitude, delivery_longitude, delivery_distance_km, scheduled_for)
       VALUES ($1, $2, $3, $4, 'web', $24, 'pendiente', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, now() + make_interval(mins => $19::int), $20, $21, $22, $23)
       RETURNING *`,
      [rid, p.branch.id, folio, input.order_type, req.customer?.id ?? null, input.name, input.phone,
        input.order_type === 'domicilio' ? p.address : null, input.order_type === 'domicilio' ? p.reference : null,
        input.notes, p.pos.tax_rate_pct, p.pos.prices_include_tax, p.totals.delivery_fee, p.provider.code,
        p.payment.payment_preference, p.payment.pay_with, token, online ? 'pendiente' : null, timeout,
        p.point?.latitude ?? null, p.point?.longitude ?? null, p.distanceKm, p.scheduledFor, channel],
    );
    const order = rows[0];
    await insertItems(db, rid, order.id, null, p.lines);
    await recalcOrder(db, rid, order);
    // Con pago en linea se acepta (o espera aceptacion) hasta que Clip confirme el pago.
    if (p.settings.auto_accept && !online) {
      await acceptOnlineOrder(db, rid, order.id, { prepMinutes: p.settings.prep_time_minutes });
    }
    if (input.save_address && req.customer && input.order_type === 'domicilio' && !input.address_id) {
      await db.query(
        `INSERT INTO customer_addresses (restaurant_id, customer_id, label, address, reference, latitude, longitude)
         SELECT $1, $2, 'Casa', $3, $4, $5, $6
          WHERE NOT EXISTS (SELECT 1 FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2 AND address = $3)
            AND (SELECT count(*) FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2) < 20`,
        [rid, req.customer.id, p.address, p.reference, p.point?.latitude ?? null, p.point?.longitude ?? null],
      );
    }
    // Direccion guardada que aun no tenia pin: se le guarda el que marco.
    if (input.address_id && input.location && p.point) {
      await db.query(
        `UPDATE customer_addresses SET latitude = $4, longitude = $5
          WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 AND latitude IS NULL`,
        [input.address_id, rid, req.customer.id, p.point.latitude, p.point.longitude],
      );
    }
    const totals = await loadOrder(db, rid, order.id);
    const next = await p.provider.start({
      db, restaurantId: rid, tenant: req.tenant, order: totals, creds, customer: req.customer,
    });
    const full = await loadOrder(db, rid, order.id);
    return { order: customerOrderView(full, p.branch), payment: next, full: { ...full, timezone: p.branch.timezone } };
  });
  // Aviso al restaurante (los de pago con Clip salen cuando Clip lo confirma).
  if (result.full.online_payment_status !== 'pendiente') void alertNewOnlineOrder(req.tenant, result.full).catch(() => {});
  return result;
}
