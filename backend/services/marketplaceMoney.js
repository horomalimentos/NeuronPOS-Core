// NeuronPOS Delivery (fase 3): el repartidor y el dinero.
//
// - Pedidos disponibles para un repartidor: aceptados o listos, sin
//   repartidor, del restaurante dentro de su radio. Los de efectivo no se le
//   ofrecen si su adeudo llego al tope. Un pedido activo a la vez.
// - Tomar, recoger (paga la comida en el restaurante) y entregar.
// - Al entregar: efectivo -> adeudo de la parte de NeuronPOS del envio;
//   tarjeta -> abono de la comida que pago + su parte del envio.
// - Ligas de Clip de la plataforma: pedido con tarjeta y pago de adeudo.
//   Como en services/clip/reconcile.js, el webhook solo dispara la consulta
//   server-to-server a Clip; el pago se aplica una sola vez (applied_at).
import { withFleetDriver, withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import { HttpError, badRequest, notFound } from '../utils/http.js';
import { createClipClient, hasCheckoutCredentials, platformClipCredentials } from './clip/client.js';
import { checkoutMismatch, normalizeClipStatus, rawStatusOf } from './clip/status.js';
import { driverCovers, getMarketplaceSettings } from './marketplace.js';
import { platformWebhookUrl } from './urls.js';

const conflict = (msg, code) => new HttpError(409, msg, code);
const round2 = (n) => Math.round(n * 100) / 100;
export const ACTIVE = ['aceptado', 'listo', 'en_camino'];

/** Sitio de la plataforma (neuronpos.app) para regresar de Clip. */
export const platformSiteUrl = () => (process.env.PLATFORM_SITE_URL || `https://${env.platformDomain}`).replace(/\/+$/, '');

export const cardPaymentsAvailable = () => hasCheckoutCredentials(platformClipCredentials());

export async function driverBalance(db, driverId) {
  return Number((await db.query(
    'SELECT coalesce(sum(amount), 0)::numeric(10,2) AS b FROM marketplace_driver_ledger WHERE driver_id = $1',
    [driverId],
  )).rows[0].b);
}

/** El adeudo llego al tope: ya no toma pedidos en efectivo. */
export const cashBlocked = (balance, limit) => Number(limit) >= 0 && -balance >= Number(limit) && -balance > 0;

async function loadDriver(db, driverId) {
  const d = (await db.query(
    `SELECT id, name, phone, status, active, on_duty, base_latitude, base_longitude, radius_km
       FROM fleet_drivers WHERE id = $1`,
    [driverId],
  )).rows[0];
  if (!d) throw notFound('Repartidor no encontrado', 'DRIVER_NOT_FOUND');
  return d;
}

const ORDER_SELECT = `
  SELECT m.*, r.name AS restaurant_name, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone,
         l.latitude AS r_lat, l.longitude AS r_lng, o.folio, o.estimated_ready_at,
         (SELECT count(*) FROM marketplace_messages x WHERE x.marketplace_order_id = m.id)::int AS messages
    FROM marketplace_orders m
    JOIN restaurants r ON r.id = m.restaurant_id
    JOIN branches b ON b.id = m.branch_id
    JOIN orders o ON o.id = m.order_id
    LEFT JOIN marketplace_listings l ON l.branch_id = m.branch_id`;

const mapsUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

/** Resumen sin datos del cliente (pedidos disponibles). */
function offerView(m) {
  return {
    id: m.id,
    restaurant_name: m.restaurant_name,
    pickup_address: m.branch_address,
    status: m.status,
    distance_km: Number(m.distance_km),
    driver_share: m.driver_share,
    payment_method: m.payment_method,
    food_total: m.food_total,
    // Efectivo: cobra esto al cliente. Tarjeta: ya esta pagado.
    collect: m.payment_method === 'efectivo' ? m.total : '0.00',
    estimated_ready_at: m.estimated_ready_at,
    created_at: m.created_at,
  };
}

/** Todo lo del pedido para el repartidor que lo lleva. */
function jobView(m) {
  return {
    ...offerView(m),
    folio: m.folio,
    pickup_phone: m.branch_phone,
    pickup_maps_url: m.r_lat === null ? null : mapsUrl(m.r_lat, m.r_lng),
    customer_name: m.customer_name,
    customer_phone: m.customer_phone,
    address: m.address,
    reference: m.reference,
    dropoff_maps_url: mapsUrl(m.latitude, m.longitude),
    pay_with: m.pay_with,
    change: m.payment_method === 'efectivo' && m.pay_with ? round2(Number(m.pay_with) - Number(m.total)) : null,
    total: m.total,
    delivery_fee: m.delivery_fee,
    platform_share: m.platform_share,
    picked_up_at: m.picked_up_at,
    delivered_at: m.delivered_at,
    messages: m.messages,
  };
}

/** Pantalla del repartidor: saldo, su pedido en curso y los disponibles. */
export async function driverBoard(driverId) {
  return withPlatform(async (db) => {
    const settings = await getMarketplaceSettings(db);
    const d = await loadDriver(db, driverId);
    const balance = await driverBalance(db, driverId);
    const blocked = cashBlocked(balance, settings.driver_debt_limit);
    const mine = (await db.query(`${ORDER_SELECT} WHERE m.driver_id = $1 AND m.status = ANY($2::text[]) ORDER BY m.assigned_at`, [driverId, ACTIVE])).rows;
    const today = (await db.query(
      `SELECT count(*)::int AS deliveries, coalesce(sum(driver_share), 0)::numeric(10,2) AS earned
         FROM marketplace_orders WHERE driver_id = $1 AND status = 'entregado' AND delivered_at > now() - interval '18 hours'`,
      [driverId],
    )).rows[0];
    let available = [];
    if (d.status === 'aprobado' && d.active && d.on_duty && !mine.length && d.base_latitude !== null) {
      available = (await db.query(
        `${ORDER_SELECT} WHERE m.driver_id IS NULL AND m.status IN ('aceptado', 'listo') AND m.created_at > now() - interval '12 hours'
          ORDER BY m.created_at`,
      )).rows.filter((m) => m.r_lat !== null && driverCovers(d, { latitude: Number(m.r_lat), longitude: Number(m.r_lng) }))
        .filter((m) => !(blocked && m.payment_method === 'efectivo'));
    }
    return {
      balance,
      debt_limit: Number(settings.driver_debt_limit),
      cash_blocked: blocked,
      card_payments: cardPaymentsAvailable(),
      today,
      active: mine.map(jobView),
      available: available.map(offerView),
    };
  });
}

async function lockOrder(db, id) {
  const m = (await db.query(`${ORDER_SELECT} WHERE m.id = $1 FOR UPDATE OF m`, [id])).rows[0];
  if (!m) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  return m;
}

/** Tomar un pedido: gana el primero (fila bloqueada). */
export async function takeOrder(driverId, orderId) {
  return withPlatform(async (db) => {
    const settings = await getMarketplaceSettings(db);
    const d = await loadDriver(db, driverId);
    if (d.status !== 'aprobado' || !d.active || !d.on_duty) throw conflict('Ponte en turno para tomar pedidos', 'NOT_ON_DUTY');
    const busy = await db.query('SELECT 1 FROM marketplace_orders WHERE driver_id = $1 AND status = ANY($2::text[])', [driverId, ACTIVE]);
    if (busy.rowCount) throw conflict('Termina tu entrega en curso antes de tomar otra', 'DRIVER_BUSY');
    const m = await lockOrder(db, orderId);
    if (m.driver_id || !['aceptado', 'listo'].includes(m.status)) throw conflict('Otro repartidor ya tomo este pedido', 'ORDER_TAKEN');
    if (m.r_lat === null || !driverCovers(d, { latitude: Number(m.r_lat), longitude: Number(m.r_lng) })) {
      throw conflict('Este restaurante esta fuera de tu zona', 'OUT_OF_ZONE');
    }
    if (m.payment_method === 'efectivo' && cashBlocked(await driverBalance(db, driverId), settings.driver_debt_limit)) {
      throw conflict('Tu adeudo llego al tope: paga para volver a tomar pedidos en efectivo', 'DEBT_LIMIT');
    }
    await db.query(
      'UPDATE marketplace_orders SET driver_id = $2, assigned_at = now(), updated_at = now() WHERE id = $1',
      [m.id, driverId],
    );
    return jobView(await lockOrder(db, m.id));
  });
}

/** Soltar un pedido que todavia no recoge (vuelve a quedar disponible). */
export async function releaseOrder(driverId, orderId) {
  return withPlatform(async (db) => {
    const m = await lockOrder(db, orderId);
    if (m.driver_id !== driverId) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
    if (!['aceptado', 'listo'].includes(m.status)) throw conflict('Ya recogiste este pedido', 'INVALID_TRANSITION');
    await db.query('UPDATE marketplace_orders SET driver_id = NULL, assigned_at = NULL, updated_at = now() WHERE id = $1', [m.id]);
  });
}

/** Recogi (y pague la comida en el restaurante). */
export async function pickUpOrder(driverId, orderId) {
  return withPlatform(async (db) => {
    const m = await lockOrder(db, orderId);
    if (m.driver_id !== driverId) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
    if (!['aceptado', 'listo'].includes(m.status)) throw conflict('Este pedido no esta para recoger', 'INVALID_TRANSITION');
    await db.query(
      `UPDATE marketplace_orders SET status = 'en_camino', picked_up_at = now(), ready_at = coalesce(ready_at, now()),
              updated_at = now() WHERE id = $1`,
      [m.id],
    );
    await db.query(
      `UPDATE orders SET ready_at = coalesce(ready_at, now()), dispatched_at = coalesce(dispatched_at, now()), updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [m.order_id, m.restaurant_id],
    );
    return jobView(await lockOrder(db, m.id));
  });
}

/** Entregado: movimientos de la cuenta del repartidor (una vez por pedido). */
export async function deliverOrder(driverId, orderId) {
  return withPlatform(async (db) => {
    const m = await lockOrder(db, orderId);
    if (m.driver_id !== driverId) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
    if (m.status !== 'en_camino') throw conflict('Marca primero que recogiste el pedido', 'INVALID_TRANSITION');
    await db.query("UPDATE marketplace_orders SET status = 'entregado', delivered_at = now(), updated_at = now() WHERE id = $1", [m.id]);
    if (m.payment_method === 'efectivo') {
      if (Number(m.platform_share) > 0) {
        await db.query(
          `INSERT INTO marketplace_driver_ledger (driver_id, marketplace_order_id, kind, amount, note)
           VALUES ($1, $2, 'comision_efectivo', $3, $4) ON CONFLICT DO NOTHING`,
          [driverId, m.id, -Number(m.platform_share), `Pedido #${m.folio} ${m.restaurant_name}: parte de NeuronPOS del envío`],
        );
      }
    } else {
      await db.query(
        `INSERT INTO marketplace_driver_ledger (driver_id, marketplace_order_id, kind, amount, note)
         VALUES ($1, $2, 'abono_tarjeta', $3, $4) ON CONFLICT DO NOTHING`,
        [driverId, m.id, round2(Number(m.food_total) + Number(m.driver_share)),
          `Pedido #${m.folio} ${m.restaurant_name} con tarjeta: comida que pagaste + tu envío`],
      );
    }
    return jobView(await lockOrder(db, m.id));
  });
}

export async function driverLedger(driverId) {
  return withFleetDriver(driverId, async (db) => ({
    balance: await driverBalance(db, driverId),
    entries: (await db.query(
      `SELECT id, kind, amount, note, created_at FROM marketplace_driver_ledger WHERE driver_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [driverId],
    )).rows,
  }));
}

// ---------------------------------------------------------------------------
// Ligas de Clip de la plataforma
// ---------------------------------------------------------------------------

async function createLink(db, { purpose, amount, description, back, orderId = null, driverId = null }) {
  const creds = platformClipCredentials();
  if (!hasCheckoutCredentials(creds)) throw badRequest('El pago con tarjeta no esta disponible por ahora', 'PAYMENT_UNAVAILABLE');
  const link = await createClipClient(creds).createCheckout({
    amount,
    description,
    redirect: { success: `${back}?pago=ok`, error: `${back}?pago=error`, default: `${back}?pago=cancelado` },
    webhookUrl: platformWebhookUrl(),
    metadata: { tipo: `delivery_${purpose}`, marketplace_order_id: orderId, driver_id: driverId },
  });
  return (await db.query(
    `INSERT INTO marketplace_checkouts (purpose, marketplace_order_id, driver_id, checkout_id, payment_url, amount, expires_at, response_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [purpose, orderId, driverId, link.checkout_id, link.payment_url, amount, link.expires_at, JSON.stringify(link.raw)],
  )).rows[0];
}

/** Liga para pagar un pedido con tarjeta (se crea despues de guardar el pedido). */
export async function createOrderCheckout(marketplaceOrderId) {
  return withPlatform(async (db) => {
    const m = (await db.query(
      `SELECT m.id, m.total, m.public_token, r.name FROM marketplace_orders m JOIN restaurants r ON r.id = m.restaurant_id
        WHERE m.id = $1`,
      [marketplaceOrderId],
    )).rows[0];
    const row = await createLink(db, {
      purpose: 'pedido',
      amount: Number(m.total),
      description: `NeuronPOS Delivery - ${m.name}`,
      back: `${platformSiteUrl()}/delivery/pedido/${m.public_token}`,
      orderId: m.id,
    });
    return { payment_url: row.payment_url, expires_at: row.expires_at };
  });
}

/** Liga para que el repartidor pague su adeudo (todo o una parte). */
export async function createDebtCheckout(driverId, amount = null) {
  return withPlatform(async (db) => {
    const debt = -(await driverBalance(db, driverId));
    if (debt <= 0) throw badRequest('No tienes adeudo', 'NO_DEBT');
    const pay = amount === null ? debt : round2(Number(amount));
    // Minimo $10 (o todo el adeudo si es menor).
    const min = Math.min(10, debt);
    if (!Number.isFinite(pay) || pay < min || pay > debt) throw badRequest(`Paga de $${min.toFixed(2)} a $${debt.toFixed(2)}`, 'INVALID_AMOUNT');
    const row = await createLink(db, {
      purpose: 'adeudo', amount: pay, description: 'NeuronPOS Delivery - pago de adeudo', back: `${platformSiteUrl()}/repartidor`, driverId,
    });
    return { payment_url: row.payment_url, amount: pay, expires_at: row.expires_at };
  });
}

/** Lo que pasa cuando Clip confirma un pago. Regresa { late }. */
async function applyCheckout(db, c, data) {
  const reference = String(data?.transaction_id || data?.receipt_no || c.checkout_id).slice(0, 200);
  if (c.purpose === 'adeudo') {
    await db.query(
      `INSERT INTO marketplace_driver_ledger (driver_id, kind, amount, note, checkout_id)
       VALUES ($1, 'pago_clip', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [c.driver_id, c.amount, `Pago con tarjeta (${reference})`, c.id],
    );
    return { late: false };
  }
  const m = (await db.query('SELECT id, status, order_id, restaurant_id FROM marketplace_orders WHERE id = $1 FOR UPDATE', [c.marketplace_order_id])).rows[0];
  // Pagado despues de cancelar: hay que reembolsar en el panel de Clip.
  if (!m || m.status !== 'pago_pendiente') return { late: true };
  await db.query("UPDATE marketplace_orders SET status = 'nuevo', paid_at = now(), updated_at = now() WHERE id = $1", [m.id]);
  await db.query(
    'UPDATE orders SET online_payment_status = NULL, payment_due_at = NULL, updated_at = now() WHERE id = $1 AND restaurant_id = $2',
    [m.order_id, m.restaurant_id],
  );
  return { late: false };
}

/** Concilia una liga con Clip (server-to-server) y aplica el pago una vez. */
export async function reconcileMarketplaceCheckout(local) {
  const creds = platformClipCredentials();
  if (!hasCheckoutCredentials(creds)) return { status: local.status, applied: false };
  const data = await createClipClient(creds).getCheckout(local.checkout_id);
  if (!data) {
    await withPlatform((db) => db.query('UPDATE marketplace_checkouts SET last_checked_at = now() WHERE id = $1', [local.id]));
    return { status: local.status, applied: false };
  }
  const mismatch = checkoutMismatch(local, data);
  if (mismatch) {
    console.error(`[Delivery Clip] ${local.checkout_id}: la respuesta de Clip no coincide (${mismatch})`);
    return { status: local.status, applied: false, mismatch };
  }
  const status = normalizeClipStatus(rawStatusOf(data), data);
  return withPlatform(async (db) => {
    const row = (await db.query('SELECT * FROM marketplace_checkouts WHERE id = $1 FOR UPDATE', [local.id])).rows[0];
    if (!row) return { status, applied: false };
    const next = row.status === 'completed' ? 'completed' : status;
    const ref = data.transaction_id || data.receipt_no || null;
    await db.query(
      `UPDATE marketplace_checkouts SET status = $2, response_data = $3, last_checked_at = now(),
              clip_reference = coalesce($4, clip_reference), updated_at = now() WHERE id = $1`,
      [row.id, next, JSON.stringify(data), ref ? String(ref).slice(0, 200) : null],
    );
    if (next === 'completed' && !row.applied_at) {
      const outcome = await applyCheckout(db, row, data);
      await db.query('UPDATE marketplace_checkouts SET applied_at = now(), late_payment = $2 WHERE id = $1', [row.id, outcome.late]);
      return { status: next, applied: !outcome.late, late: outcome.late };
    }
    // Liga vencida o cancelada de un pedido sin pagar: el pedido se cancela.
    if (['expired', 'cancelled', 'failed'].includes(next) && row.purpose === 'pedido') await cancelUnpaidOrder(db, row.marketplace_order_id);
    return { status: next, applied: false };
  });
}

/** Cancela un pedido con tarjeta que no se pago (si no tiene otra liga viva). */
export async function cancelUnpaidOrder(db, marketplaceOrderId, reason = 'No se completó el pago con tarjeta') {
  const m = (await db.query(
    "SELECT id, order_id, restaurant_id FROM marketplace_orders WHERE id = $1 AND status = 'pago_pendiente' FOR UPDATE",
    [marketplaceOrderId],
  )).rows[0];
  if (!m) return;
  const other = await db.query(
    "SELECT 1 FROM marketplace_checkouts WHERE marketplace_order_id = $1 AND status IN ('pending', 'completed')",
    [m.id],
  );
  if (other.rowCount) return;
  await db.query(
    `UPDATE marketplace_orders SET status = 'cancelado', cancel_reason = $2,
            cancelled_at = now(), updated_at = now() WHERE id = $1`,
    [m.id, reason],
  );
  await db.query(
    `UPDATE orders SET status = 'cancelada', online_payment_status = 'cancelado', cancel_reason = $3,
            cancelled_at = now(), updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
    [m.order_id, m.restaurant_id, reason],
  );
}

/** Webhook de la plataforma: si el id es de una liga de Delivery. */
export async function reconcileMarketplaceCheckoutId(checkoutId) {
  if (!checkoutId) return { matched: false };
  const local = await withPlatform(async (db) => (await db.query('SELECT * FROM marketplace_checkouts WHERE checkout_id = $1', [checkoutId])).rows[0]);
  if (!local) return { matched: false };
  return { matched: true, ...(await reconcileMarketplaceCheckout(local)) };
}

/** Job: ligas pendientes (por si no llego el webhook) y pedidos sin pagar vencidos. */
export async function reconcilePendingMarketplaceCheckouts({ limit = 100 } = {}) {
  const pending = await withPlatform(async (db) => (await db.query(
    `SELECT * FROM marketplace_checkouts WHERE status = 'pending' AND created_at > now() - interval '3 days'
      ORDER BY last_checked_at NULLS FIRST, created_at LIMIT $1`,
    [limit],
  )).rows);
  let applied = 0;
  for (const c of pending) {
    try {
      const r = await reconcileMarketplaceCheckout(c);
      if (r.applied) applied += 1;
      // Un pedido con tarjeta no espera mas de 30 min a que paguen.
      else if (r.status === 'pending' && c.purpose === 'pedido' && Date.now() - new Date(c.created_at).getTime() > 30 * 60000) {
        await withPlatform(async (db) => {
          await db.query("UPDATE marketplace_checkouts SET status = 'expired', updated_at = now() WHERE id = $1", [c.id]);
          await cancelUnpaidOrder(db, c.marketplace_order_id);
        });
      }
    } catch (err) {
      console.error('[Delivery Clip] conciliacion fallo:', err.message);
    }
  }
  return { checked: pending.length, applied };
}

/**
 * Seguimiento de un pedido con tarjeta sin pagar: concilia su liga con Clip
 * (al volver de Clip el webhook puede no haber llegado) y regresa la liga
 * vigente para reintentar el pago.
 */
export async function refreshOrderPayment(token) {
  const c = await withPlatform(async (db) => (await db.query(
    `SELECT c.* FROM marketplace_checkouts c JOIN marketplace_orders m ON m.id = c.marketplace_order_id
      WHERE m.public_token = $1 AND m.status = 'pago_pendiente' AND c.status = 'pending'
      ORDER BY c.created_at DESC LIMIT 1`,
    [token],
  )).rows[0]);
  if (!c) return null;
  try {
    const r = await reconcileMarketplaceCheckout(c);
    if (r.status !== 'pending') return null;
  } catch (err) {
    console.error('[Delivery Clip] no se pudo consultar la liga:', err.message);
  }
  return c.payment_url;
}
