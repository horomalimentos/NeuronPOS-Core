// Panel NeuronPOS: flota de repartidores de la plataforma (modo 'horom').
// Repartidores, tablero de reparto (asignar, ofrecer, estados), mapa,
// liquidaciones a restaurantes, corte de efectivo por repartidor y reporte
// de pagos a repartidores. Montado dentro de routes/platform.js
// (authenticatePlatform ya corrio); todo con withPlatform.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import {
  applyRequestTransition, assignDriver, createSettlement, getFleetSettings, lockRequest, offerRequest,
  pendingLedger, unassignDriver,
} from '../services/delivery/fleet.js';
import { DELIVERY_STATUSES, DELIVERY_STATUS_LABEL } from '../services/delivery/flow.js';
import { driverCut, sumMoney } from '../services/delivery/math.js';
import {
  EMAIL_RE, HttpError, ah, badRequest, bool, buildSet, money, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';

const router = Router();
const conflict = (msg, code) => new HttpError(409, msg, code);

// ---------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------

router.get('/fleet/settings', ah(async (req, res) => {
  res.json({ settings: await withPlatform((db) => getFleetSettings(db)) });
}));

router.put('/fleet/settings', ah(async (req, res) => {
  const body = req.body || {};
  let seconds;
  if (body.offer_seconds !== undefined) {
    seconds = Number(body.offer_seconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) {
      throw badRequest('El tiempo de la oferta debe ser de 15 a 3600 segundos', 'INVALID_FIELD');
    }
  }
  const set = buildSet({
    driver_pay_per_delivery: money(body.driver_pay_per_delivery, { field: 'driver_pay_per_delivery' }),
    auto_offer: bool(body.auto_offer, 'auto_offer'),
    offer_seconds: seconds,
  });
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const settings = await withPlatform(async (db) => {
    await db.query(`UPDATE fleet_settings SET ${set.sql}, updated_at = now() WHERE id`, set.values);
    return getFleetSettings(db);
  });
  res.json({ settings });
}));

// ---------------------------------------------------------------------------
// Repartidores
// ---------------------------------------------------------------------------

const DRIVER_COLS = `d.id, d.name, d.phone, d.email, d.vehicle, d.plate, d.active, d.pay_per_delivery, d.on_duty,
  d.notes, d.last_login_at, d.created_at, d.updated_at`;

async function listDrivers(db, id = null) {
  return (await db.query(
    `SELECT ${DRIVER_COLS}, l.latitude, l.longitude, l.updated_at AS located_at,
            (SELECT count(*) FROM delivery_requests r
              WHERE r.driver_id = d.id AND r.status IN ('asignado', 'recogido', 'en_camino'))::int AS active_requests,
            coalesce((SELECT sum(r.cash_collected) FROM delivery_requests r
              WHERE r.driver_id = d.id AND r.status = 'entregado' AND r.driver_cut_id IS NULL), 0)::numeric(10,2) AS cash_pending
       FROM fleet_drivers d
       LEFT JOIN fleet_driver_locations l ON l.driver_id = d.id
      ${id ? 'WHERE d.id = $1' : ''}
      ORDER BY d.active DESC, d.on_duty DESC, d.name`,
    id ? [id] : [],
  )).rows;
}

function driverFields(body, creating) {
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 120 }),
    phone: str(body.phone, { field: 'phone', required: creating, max: 40 }),
    email: str(body.email, { field: 'email', required: creating, max: 200 })?.toLowerCase(),
    vehicle: str(body.vehicle, { field: 'vehicle', max: 80 }),
    plate: str(body.plate, { field: 'plate', max: 20 }),
    notes: str(body.notes, { field: 'notes', max: 500 }),
    active: bool(body.active, 'active'),
    pay_per_delivery: money(body.pay_per_delivery, { field: 'pay_per_delivery', nullable: true }),
  };
  if (!creating) {
    for (const k of ['name', 'phone', 'email']) if (f[k] === null) throw badRequest(`El campo "${k}" es obligatorio`, 'MISSING_FIELD');
  }
  if (f.email && !EMAIL_RE.test(f.email)) throw badRequest('Correo invalido', 'INVALID_EMAIL');
  return f;
}

async function readPassword(value, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('La contrasena es obligatoria', 'MISSING_FIELD');
    return undefined;
  }
  if (typeof value !== 'string' || value.length < 8) throw badRequest('La contrasena debe tener al menos 8 caracteres', 'WEAK_PASSWORD');
  return bcrypt.hash(value, 12);
}

router.get('/fleet/drivers', ah(async (req, res) => {
  res.json({ drivers: await withPlatform((db) => listDrivers(db)) });
}));

router.post('/fleet/drivers', ah(async (req, res) => {
  const body = req.body || {};
  const f = driverFields(body, true);
  f.password_hash = await readPassword(body.password, true);
  const driver = await withPlatform(async (db) => {
    const cols = Object.entries(f).filter(([, v]) => v !== undefined);
    const { rows } = await db.query(
      `INSERT INTO fleet_drivers (${cols.map(([k]) => k).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map(([, v]) => v),
    );
    return (await listDrivers(db, rows[0].id))[0];
  });
  res.status(201).json({ driver });
}));

router.patch('/fleet/drivers/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const f = driverFields(body, false);
  f.password_hash = await readPassword(body.password, false);
  if (f.active === false) f.on_duty = false;
  const set = buildSet(f, 2);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const driver = await withPlatform(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE fleet_drivers SET ${set.sql}, updated_at = now() WHERE id = $1`,
      [req.params.id, ...set.values],
    );
    if (!rowCount) throw notFound('Repartidor no encontrado', 'DRIVER_NOT_FOUND');
    return (await listDrivers(db, req.params.id))[0];
  });
  res.json({ driver });
}));

// ---------------------------------------------------------------------------
// Tablero de reparto
// ---------------------------------------------------------------------------

const requestView = (r) => ({ ...r, status_label: DELIVERY_STATUS_LABEL[r.status] });

router.get('/fleet/requests', ah(async (req, res) => {
  const status = oneOf(req.query.status || 'activas', ['activas', 'todas', ...DELIVERY_STATUSES], 'status');
  const params = [];
  const where = [];
  if (status === 'activas') where.push(`(r.status IN ('solicitado', 'asignado', 'recogido', 'en_camino') OR r.updated_at > now() - interval '12 hours')`);
  else if (status !== 'todas') { params.push(status); where.push(`r.status = $${params.length}`); }
  if (req.query.restaurant_id) { params.push(requireUuid(req.query.restaurant_id, 'restaurant_id')); where.push(`r.restaurant_id = $${params.length}`); }
  const data = await withPlatform(async (db) => {
    const requests = (await db.query(
      `SELECT r.*,
              (SELECT count(*) FROM delivery_request_offers f
                WHERE f.request_id = r.id AND f.status = 'ofrecida' AND f.expires_at > now())::int AS open_offers
         FROM delivery_requests r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (r.status = 'solicitado') DESC, (r.status IN ('asignado', 'recogido', 'en_camino')) DESC, r.created_at DESC
        LIMIT 300`,
      params,
    )).rows;
    return { requests: requests.map(requestView), drivers: await listDrivers(db) };
  });
  res.json(data);
}));

async function onRequest(req, fn) {
  requireUuid(req.params.id);
  return withPlatform(async (db) => fn(db, await lockRequest(db, req.params.id)));
}

router.post('/fleet/requests/:id/assign', ah(async (req, res) => {
  const driverId = requireUuid((req.body || {}).driver_id, 'driver_id');
  const request = await onRequest(req, (db, r) => assignDriver(db, r, driverId));
  res.json({ request: requestView(request) });
}));

router.post('/fleet/requests/:id/unassign', ah(async (req, res) => {
  const request = await onRequest(req, (db, r) => unassignDriver(db, r));
  res.json({ request: requestView(request) });
}));

router.post('/fleet/requests/:id/offer', ah(async (req, res) => {
  const offered = await onRequest(req, async (db, r) => {
    if (r.status !== 'solicitado') throw conflict('Solo se ofrecen solicitudes sin repartidor', 'INVALID_TRANSITION');
    return offerRequest(db, r.id);
  });
  res.json({ offered });
}));

// Estados en nombre del repartidor (o cancelar), con la misma validacion.
router.post('/fleet/requests/:id/status', ah(async (req, res) => {
  const body = req.body || {};
  const status = oneOf(body.status, DELIVERY_STATUSES, 'status');
  if (!status) throw badRequest('Indica el nuevo estado', 'MISSING_FIELD');
  const reason = str(body.reason, { field: 'reason', max: 300 }) || null;
  const request = await onRequest(req, (db, r) => applyRequestTransition(db, r, status, { reason }));
  res.json({ request: requestView(request) });
}));

// Corregir la comision de una entrega (antes de facturarla o liquidarla).
router.patch('/fleet/requests/:id', ah(async (req, res) => {
  const amount = money((req.body || {}).commission_amount, { field: 'commission_amount' });
  if (amount === undefined) throw badRequest('Indica la comision', 'MISSING_FIELD');
  const request = await onRequest(req, async (db, r) => {
    if (r.commission_invoice_id || r.commission_settlement_id) {
      throw conflict('La comision ya se cobro en una factura o liquidacion', 'COMMISSION_BILLED');
    }
    return (await db.query(
      'UPDATE delivery_requests SET commission_amount = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [r.id, amount],
    )).rows[0];
  });
  res.json({ request: requestView(request) });
}));

router.get('/fleet/map', ah(async (req, res) => {
  const data = await withPlatform(async (db) => ({
    drivers: (await db.query(
      `SELECT d.id, d.name, d.phone, d.on_duty, l.latitude, l.longitude, l.accuracy_m, l.updated_at AS located_at,
              (SELECT json_build_object('id', r.id, 'status', r.status, 'restaurant_name', r.restaurant_name, 'folio', r.order_folio)
                 FROM delivery_requests r WHERE r.driver_id = d.id AND r.status IN ('asignado', 'recogido', 'en_camino')
                ORDER BY r.assigned_at DESC LIMIT 1) AS request
         FROM fleet_drivers d JOIN fleet_driver_locations l ON l.driver_id = d.id
        WHERE d.active AND (d.on_duty OR EXISTS (SELECT 1 FROM delivery_requests r
                                                  WHERE r.driver_id = d.id AND r.status IN ('asignado', 'recogido', 'en_camino')))
          AND l.updated_at > now() - interval '30 minutes'`,
    )).rows,
  }));
  res.json(data);
}));

// ---------------------------------------------------------------------------
// Liquidaciones a restaurantes
// ---------------------------------------------------------------------------

router.get('/fleet/ledger', ah(async (req, res) => {
  const restaurants = await withPlatform(async (db) => {
    const list = (await db.query(
      `SELECT r.id, r.name, r.slug, s.mode, s.horom_enabled, s.horom_fee_type, s.horom_fee_value
         FROM restaurants r JOIN delivery_settings s ON s.restaurant_id = r.id
        WHERE s.horom_enabled OR EXISTS (SELECT 1 FROM delivery_requests x WHERE x.restaurant_id = r.id)
        ORDER BY r.name`,
    )).rows;
    const out = [];
    for (const r of list) {
      const { cash, commissions, payout, ...summary } = await pendingLedger(db, r.id);
      const last = (await db.query(
        'SELECT created_at, net_amount FROM fleet_settlements WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 1',
        [r.id],
      )).rows[0];
      out.push({ ...r, ...summary, payout_now: payout.net_amount, last_settlement: last || null });
    }
    return out;
  });
  res.json({ restaurants });
}));

router.get('/fleet/ledger/:restaurantId', ah(async (req, res) => {
  const rid = requireUuid(req.params.restaurantId, 'restaurantId');
  const data = await withPlatform(async (db) => {
    const r = (await db.query('SELECT id, name, slug FROM restaurants WHERE id = $1', [rid])).rows[0];
    if (!r) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    const ledger = await pendingLedger(db, rid);
    const settlements = (await db.query(
      `SELECT s.*, a.name AS created_by_name FROM fleet_settlements s
         LEFT JOIN platform_admins a ON a.id = s.created_by
        WHERE s.restaurant_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
      [rid],
    )).rows;
    return { restaurant: r, ledger, settlements };
  });
  res.json(data);
}));

router.post('/fleet/settlements', ah(async (req, res) => {
  const body = req.body || {};
  const rid = requireUuid(body.restaurant_id, 'restaurant_id');
  const method = oneOf(body.method ?? 'transferencia', ['transferencia', 'efectivo', 'otro'], 'method');
  const settlement = await withPlatform(async (db) => {
    const r = (await db.query('SELECT 1 FROM restaurants WHERE id = $1', [rid])).rowCount;
    if (!r) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    return createSettlement(db, rid, {
      method,
      reference: str(body.reference, { field: 'reference', max: 120 }) || null,
      notes: str(body.notes, { field: 'notes', max: 500 }) || null,
      adminId: req.platformAdmin.id,
    });
  });
  res.status(201).json({ settlement });
}));

// ---------------------------------------------------------------------------
// Corte de efectivo por repartidor
// ---------------------------------------------------------------------------

async function driverPendingCash(db, driverId, { lock = false } = {}) {
  return (await db.query(
    `SELECT id, restaurant_name, order_folio, delivered_at, cash_collected AS amount, 0 AS tip, id AS order_id
       FROM delivery_requests
      WHERE driver_id = $1 AND status = 'entregado' AND driver_cut_id IS NULL AND cash_collected > 0
      ORDER BY delivered_at ${lock ? 'FOR UPDATE' : ''}`,
    [driverId],
  )).rows;
}

router.get('/fleet/drivers/:id/cash', ah(async (req, res) => {
  requireUuid(req.params.id);
  const data = await withPlatform(async (db) => {
    const driver = (await listDrivers(db, req.params.id))[0];
    if (!driver) throw notFound('Repartidor no encontrado', 'DRIVER_NOT_FOUND');
    const pending = await driverPendingCash(db, driver.id);
    const cuts = (await db.query(
      `SELECT c.*, a.name AS created_by_name FROM fleet_driver_cuts c
         LEFT JOIN platform_admins a ON a.id = c.created_by
        WHERE c.driver_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
      [driver.id],
    )).rows;
    return { driver, pending, ...driverCut(pending), cuts };
  });
  res.json(data);
}));

router.post('/fleet/drivers/:id/cuts', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const counted = money(body.counted_cash, { field: 'counted_cash' });
  if (counted === undefined) throw badRequest('Captura el efectivo que entrega el repartidor', 'MISSING_FIELD');
  const notes = str(body.notes, { field: 'notes', max: 300 }) || null;
  const cut = await withPlatform(async (db) => {
    const exists = (await db.query('SELECT 1 FROM fleet_drivers WHERE id = $1', [req.params.id])).rowCount;
    if (!exists) throw notFound('Repartidor no encontrado', 'DRIVER_NOT_FOUND');
    const pending = await driverPendingCash(db, req.params.id, { lock: true });
    if (!pending.length) throw conflict('El repartidor no tiene efectivo pendiente de entregar', 'NOTHING_TO_SETTLE');
    const c = driverCut(pending, counted);
    const row = (await db.query(
      `INSERT INTO fleet_driver_cuts (driver_id, expected_cash, counted_cash, difference, deliveries_count, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, c.expected_cash, c.counted_cash, c.difference, pending.length, notes, req.platformAdmin.id],
    )).rows[0];
    await db.query(
      'UPDATE delivery_requests SET driver_cut_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])',
      [pending.map((p) => p.id), row.id],
    );
    return row;
  });
  res.status(201).json({ cut });
}));

// ---------------------------------------------------------------------------
// Reporte: entregas y pago a repartidores por periodo
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/fleet/report', ah(async (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw badRequest('Indica las fechas from y to (AAAA-MM-DD)', 'INVALID_DATE');
  if (from > to) throw badRequest('La fecha inicial es posterior a la final', 'INVALID_DATE');
  const data = await withPlatform(async (db) => {
    // Dia calendario en la zona horaria de cobro de la plataforma.
    const rows = (await db.query(
      `SELECT d.id AS driver_id, d.name, d.active,
              count(r.id)::int AS deliveries,
              coalesce(sum(r.driver_pay), 0)::numeric(10,2) AS driver_pay,
              coalesce(sum(r.cash_collected), 0)::numeric(10,2) AS cash_collected,
              coalesce(sum(r.commission_amount), 0)::numeric(10,2) AS commission
         FROM fleet_drivers d
         LEFT JOIN delivery_requests r ON r.driver_id = d.id AND r.status = 'entregado'
              AND (r.delivered_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        GROUP BY d.id ORDER BY d.name`,
      [from, to, env.billingTimezone],
    )).rows;
    const failed = (await db.query(
      `SELECT driver_id, count(*)::int AS n FROM delivery_requests
        WHERE status = 'fallido' AND (failed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        GROUP BY driver_id`,
      [from, to, env.billingTimezone],
    )).rows;
    const drivers = rows.map((r) => ({ ...r, failed: failed.find((f) => f.driver_id === r.driver_id)?.n || 0 }));
    return {
      from,
      to,
      drivers,
      totals: {
        deliveries: drivers.reduce((s, d) => s + d.deliveries, 0),
        driver_pay: sumMoney(drivers, 'driver_pay'),
        cash_collected: sumMoney(drivers, 'cash_collected'),
        commission: sumMoney(drivers, 'commission'),
      },
    };
  });
  res.json(data);
}));

export default router;
