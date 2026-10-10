// Flota de repartidores de la plataforma (modo 'horom', fase 5).
//
// Las solicitudes viven en delivery_requests (tabla de plataforma con
// restaurant_id). Cada cambio de estado se refleja en la orden del
// restaurante dentro de la MISMA transaccion (asTenant): en camino, regreso
// a "listo" si falla y, al entregar, el cobro en la puerta y la orden pagada.
//
// Reciben un `db` de withPlatform (Panel) o de withFleetDriver (app del
// repartidor); las ofertas y la asignacion siempre corren como plataforma.
import { asTenant, withPlatform } from '../../config/database.js';
import { HttpError, badRequest, notFound } from '../../utils/http.js';
import { fromCents, toCents } from '../posMath.js';
import { DELIVERY_STATUS_LABEL, STATUS_TIMESTAMP, assertTransition } from './flow.js';
import { settlementPlan, sumMoney } from './math.js';
import { syncOrderStatus } from './tenant.js';

const conflict = (msg, code) => new HttpError(409, msg, code);

export async function getFleetSettings(db) {
  return (await db.query(
    'SELECT driver_pay_per_delivery, auto_offer, offer_seconds, updated_at FROM fleet_settings WHERE id',
  )).rows[0] || { driver_pay_per_delivery: '0.00', auto_offer: false, offer_seconds: 120, updated_at: null };
}

export async function lockRequest(db, id) {
  const { rows } = await db.query('SELECT * FROM delivery_requests WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Solicitud de reparto no encontrada', 'REQUEST_NOT_FOUND');
  return rows[0];
}

/**
 * Cambio de estado de una solicitud (Panel o repartidor). opts: { reason }.
 * Al entregar fija el pago del repartidor y lo cobrado en la puerta.
 */
export async function applyRequestTransition(db, request, to, { reason = null } = {}) {
  assertTransition(request.status, to);
  if (to === 'asignado') throw badRequest('Para asignar usa la asignacion de repartidor', 'USE_ASSIGN');
  if ((to === 'fallido' || to === 'cancelado') && !reason) {
    throw badRequest(to === 'fallido' ? 'Escribe el motivo por el que no se entrego' : 'Escribe el motivo de la cancelacion', 'REASON_REQUIRED');
  }
  const paid = await asTenant(db, request.restaurant_id, (tdb) => syncOrderStatus(
    tdb, request.restaurant_id, request.order_id, to, { deliveryRequestId: request.id },
  ));
  let driverPay = null;
  if (to === 'entregado') {
    const settings = await getFleetSettings(db);
    const driver = (await db.query('SELECT pay_per_delivery FROM fleet_drivers WHERE id = $1', [request.driver_id])).rows[0];
    driverPay = driver?.pay_per_delivery ?? settings.driver_pay_per_delivery;
  }
  const ts = STATUS_TIMESTAMP[to];
  const { rows } = await db.query(
    `UPDATE delivery_requests SET status = $2, ${ts} = now(), updated_at = now(),
            fail_reason = CASE WHEN $2 = 'fallido' THEN $3 ELSE fail_reason END,
            cancel_reason = CASE WHEN $2 = 'cancelado' THEN $3 ELSE cancel_reason END,
            cash_collected = CASE WHEN $2 = 'entregado' THEN $4::numeric ELSE cash_collected END,
            driver_pay = coalesce($5::numeric, driver_pay)
      WHERE id = $1 RETURNING *`,
    [request.id, to, reason, fromCents(toCents(paid.amount)), driverPay],
  );
  if (to === 'cancelado') {
    await db.query(
      `UPDATE delivery_request_offers SET status = 'expirada', responded_at = now()
        WHERE request_id = $1 AND status = 'ofrecida'`,
      [request.id],
    );
  }
  return rows[0];
}

/** Asigna (o cambia) el repartidor de una solicitud. Solo plataforma. */
export async function assignDriver(db, request, driverId) {
  if (!['solicitado', 'asignado'].includes(request.status)) {
    throw conflict('Solo se asignan solicitudes que no se han recogido', 'INVALID_TRANSITION');
  }
  const driver = (await db.query('SELECT id, name, phone, active, status FROM fleet_drivers WHERE id = $1', [driverId])).rows[0];
  if (!driver || !driver.active || driver.status !== 'aprobado') throw badRequest('Repartidor no valido', 'DRIVER_NOT_FOUND');
  const { rows } = await db.query(
    `UPDATE delivery_requests SET status = 'asignado', driver_id = $2, driver_name = $3, driver_phone = $4,
            assigned_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [request.id, driver.id, driver.name, driver.phone],
  );
  await db.query(
    `UPDATE delivery_request_offers SET status = CASE WHEN driver_id = $2 THEN 'aceptada' ELSE 'expirada' END,
            responded_at = now()
      WHERE request_id = $1 AND status = 'ofrecida'`,
    [request.id, driver.id],
  );
  return rows[0];
}

/** Le quita el repartidor (antes de recoger): vuelve a "buscando repartidor". */
export async function unassignDriver(db, request) {
  if (request.status !== 'asignado') throw conflict('Solo se puede quitar el repartidor antes de que recoja el pedido', 'INVALID_TRANSITION');
  const { rows } = await db.query(
    `UPDATE delivery_requests SET status = 'solicitado', driver_id = NULL, driver_name = NULL, driver_phone = NULL,
            assigned_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [request.id],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Ofertas
// ---------------------------------------------------------------------------

/** Resumen que ve un repartidor en una oferta (sin datos del cliente). */
export const offerSummary = (r) => ({
  restaurant_name: r.restaurant_name,
  pickup_name: r.pickup_name,
  pickup_address: r.pickup_address,
  // Solo la zona de entrega (la direccion completa se ve al aceptar).
  dropoff_area: String(r.dropoff_address || '').split(',').slice(-2).join(',').trim() || null,
  cash_to_collect: r.cash_to_collect,
});

/**
 * Ofrece una solicitud "buscando repartidor" a los repartidores activos,
 * en turno y sin reparto en curso. Regresa cuantas ofertas creo.
 */
export async function offerRequest(db, requestId) {
  const r = await lockRequest(db, requestId);
  if (r.status !== 'solicitado') return 0;
  const { offer_seconds: seconds } = await getFleetSettings(db);
  const { rowCount } = await db.query(
    `INSERT INTO delivery_request_offers (request_id, driver_id, summary, expires_at)
     SELECT $1, d.id, $2::jsonb, now() + make_interval(secs => $3)
       FROM fleet_drivers d
      WHERE d.active AND d.on_duty AND d.status = 'aprobado'
        AND NOT EXISTS (SELECT 1 FROM delivery_requests x
                         WHERE x.driver_id = d.id AND x.status IN ('asignado', 'recogido', 'en_camino'))
     ON CONFLICT (request_id, driver_id) DO UPDATE
        SET status = 'ofrecida', expires_at = EXCLUDED.expires_at, responded_at = NULL, summary = EXCLUDED.summary
      WHERE delivery_request_offers.status IN ('expirada', 'ofrecida')`,
    [r.id, JSON.stringify(offerSummary(r)), seconds],
  );
  return rowCount;
}

/** Despues de crear una solicitud: oferta automatica si el Panel la activo. */
export async function autoOffer(requestId) {
  try {
    return await withPlatform(async (db) => ((await getFleetSettings(db)).auto_offer ? offerRequest(db, requestId) : 0));
  } catch (err) {
    console.error('[flota] no se pudo ofrecer la solicitud', requestId, err.message);
    return 0;
  }
}

/** El repartidor acepta una oferta: gana el primero (la solicitud queda bloqueada). */
export async function acceptOffer(db, offerId, driverId) {
  const offer = (await db.query(
    'SELECT * FROM delivery_request_offers WHERE id = $1 AND driver_id = $2 FOR UPDATE',
    [offerId, driverId],
  )).rows[0];
  if (!offer) throw notFound('Oferta no encontrada', 'OFFER_NOT_FOUND');
  if (offer.status !== 'ofrecida' || new Date(offer.expires_at) <= new Date()) {
    throw conflict('Esta oferta ya no esta disponible', 'OFFER_EXPIRED');
  }
  const request = await lockRequest(db, offer.request_id);
  if (request.status !== 'solicitado') {
    await db.query("UPDATE delivery_request_offers SET status = 'expirada', responded_at = now() WHERE id = $1", [offer.id]);
    throw conflict('Otro repartidor ya tomo este pedido', 'OFFER_TAKEN');
  }
  const busy = (await db.query(
    `SELECT 1 FROM delivery_requests WHERE driver_id = $1 AND status IN ('asignado', 'recogido', 'en_camino') LIMIT 1`,
    [driverId],
  )).rowCount;
  if (busy) throw conflict('Termina tu entrega actual antes de tomar otra', 'DRIVER_BUSY');
  return assignDriver(db, request, driverId);
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

/** Lo que ve el repartidor de la flota de una solicitud asignada. */
export function driverRequestView(r) {
  return {
    id: r.id,
    status: r.status,
    status_label: DELIVERY_STATUS_LABEL[r.status],
    restaurant_name: r.restaurant_name,
    order_folio: r.order_folio,
    pickup_name: r.pickup_name,
    pickup_address: r.pickup_address,
    pickup_phone: r.pickup_phone,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    dropoff_address: r.dropoff_address,
    dropoff_reference: r.dropoff_reference,
    notes: r.notes,
    order_total: r.order_total,
    cash_to_collect: r.cash_to_collect,
    pay_with: r.pay_with,
    cash_collected: r.cash_collected,
    fail_reason: r.fail_reason,
    assigned_at: r.assigned_at,
    picked_up_at: r.picked_up_at,
    on_way_at: r.on_way_at,
    delivered_at: r.delivered_at,
    failed_at: r.failed_at,
    driver_pay: r.driver_pay,
  };
}

// ---------------------------------------------------------------------------
// Liquidaciones a restaurantes
// ---------------------------------------------------------------------------

/**
 * Pendiente de liquidar de un restaurante (db de plataforma o del propio
 * restaurante): efectivo cobrado por la flota sin entregar y comisiones sin
 * facturar ni descontar.
 */
export async function pendingLedger(db, restaurantId, { lock = false } = {}) {
  const cash = (await db.query(
    `SELECT id, order_folio, delivered_at, cash_collected FROM delivery_requests
      WHERE restaurant_id = $1 AND status = 'entregado' AND cash_settlement_id IS NULL AND cash_collected > 0
      ORDER BY delivered_at, id ${lock ? 'FOR UPDATE' : ''}`,
    [restaurantId],
  )).rows;
  const commissions = (await db.query(
    `SELECT id, order_folio, delivered_at, commission_amount FROM delivery_requests
      WHERE restaurant_id = $1 AND status = 'entregado' AND commission_amount > 0
        AND commission_invoice_id IS NULL AND commission_settlement_id IS NULL
      ORDER BY delivered_at, id ${lock ? 'FOR UPDATE' : ''}`,
    [restaurantId],
  )).rows;
  const plan = settlementPlan(cash, commissions);
  return {
    cash_pending: sumMoney(cash, 'cash_collected'),
    commission_pending: sumMoney(commissions, 'commission_amount'),
    cash_deliveries: cash.length,
    commission_deliveries: commissions.length,
    // Lo que se pagaria hoy al liquidar (las comisiones que no quepan se facturan).
    payout: plan,
    cash,
    commissions,
  };
}

/** Registra una liquidacion al restaurante con lo pendiente. Solo plataforma. */
export async function createSettlement(db, restaurantId, { method = 'transferencia', reference = null, notes = null, adminId = null }) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`flota:liquidacion:${restaurantId}`]);
  const ledger = await pendingLedger(db, restaurantId, { lock: true });
  const plan = ledger.payout;
  if (!plan.cash_ids.length && !plan.commission_ids.length) {
    throw conflict('No hay nada pendiente de liquidar', 'NOTHING_TO_SETTLE');
  }
  const ids = new Set([...plan.cash_ids, ...plan.commission_ids]);
  const s = (await db.query(
    `INSERT INTO fleet_settlements (restaurant_id, cash_amount, commission_amount, net_amount, deliveries_count,
                                    method, reference, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [restaurantId, plan.cash_amount, plan.commission_amount, plan.net_amount, ids.size, method, reference, notes, adminId],
  )).rows[0];
  await db.query(
    'UPDATE delivery_requests SET cash_settlement_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])',
    [plan.cash_ids, s.id],
  );
  await db.query(
    'UPDATE delivery_requests SET commission_settlement_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])',
    [plan.commission_ids, s.id],
  );
  return s;
}

// ---------------------------------------------------------------------------
// Comisiones en la factura mensual
// ---------------------------------------------------------------------------

export const HOROM_INVOICE_CODE = 'domicilios_horom';

/**
 * Comisiones de entregas que aun no se facturan ni se descontaron en una
 * liquidacion (las bloquea). La usa generateInvoice (db de plataforma).
 */
export async function pendingInvoiceCharges(db, restaurantId, now = new Date()) {
  const rows = (await db.query(
    `SELECT id, commission_amount FROM delivery_requests
      WHERE restaurant_id = $1 AND status = 'entregado' AND commission_amount > 0
        AND commission_invoice_id IS NULL AND commission_settlement_id IS NULL AND delivered_at <= $2
      ORDER BY delivered_at, id FOR UPDATE`,
    [restaurantId, now],
  )).rows;
  const cents = rows.reduce((s, r) => s + toCents(r.commission_amount), 0);
  return { ids: rows.map((r) => r.id), count: rows.length, amount_mxn: fromCents(cents) };
}

/** Linea de factura de las comisiones (formato de buildInvoiceLines). */
export const horomInvoiceLine = (charges) => ({
  module_code: HOROM_INVOICE_CODE,
  name: `Domicilios Horom (${charges.count} ${charges.count === 1 ? 'entrega' : 'entregas'})`,
  catalog_price_mxn: charges.amount_mxn,
  custom_price_mxn: null,
  unit_price_mxn: charges.amount_mxn,
  discount_pct: 0,
  discount_mxn: 0,
  amount_mxn: charges.amount_mxn,
});
