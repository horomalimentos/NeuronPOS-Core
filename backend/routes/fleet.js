// App de los repartidores de la flota de la plataforma (modo 'horom').
// Login propio (token con audiencia 'fleet'); todo corre con
// withFleetDriver: RLS solo deja ver la fila del repartidor, sus ofertas,
// sus cortes y las solicitudes que tiene asignadas (con la copia minima de
// datos del pedido), nunca tablas de los restaurantes.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { withFleetDriver, withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticateFleet, signFleetToken } from '../middleware/auth.js';
import {
  acceptOffer, applyRequestTransition, driverRequestView, lockRequest,
} from '../services/delivery/fleet.js';
import { DRIVER_STATUSES } from '../services/delivery/flow.js';
import { readLocation } from '../services/delivery/location.js';
import { readPoint } from '../services/deliveryZones.js';
import { getMarketplaceSettings } from '../services/marketplace.js';
import { mapsUrl } from '../services/online.js';
import {
  HttpError, ah, badRequest, bool, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: 'Demasiados intentos de inicio de sesion. Intenta de nuevo en unos minutos.', code: 'RATE_LIMITED' },
});
const DUMMY_HASH = bcrypt.hashSync('no-existe', 10);

router.post('/auth/login', loginLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const email = str(body.email, { field: 'email', required: true, max: 200 }).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) throw badRequest('La contrasena es obligatoria', 'MISSING_FIELD');
  // El login es de la plataforma: busca al repartidor por correo.
  const driver = await withPlatform(async (db) => (await db.query(
    'SELECT id, name, email, active, password_hash FROM fleet_drivers WHERE email = $1',
    [email],
  )).rows[0]);
  const ok = await bcrypt.compare(password, driver?.password_hash || DUMMY_HASH);
  if (!driver || !ok || !driver.active) throw new HttpError(401, 'Correo o contrasena incorrectos', 'INVALID_CREDENTIALS');
  await withFleetDriver(driver.id, (db) => db.query('UPDATE fleet_drivers SET last_login_at = now() WHERE id = $1', [driver.id]));
  res.json({ token: signFleetToken(driver), driver: { id: driver.id, name: driver.name, email: driver.email } });
}));

router.use(authenticateFleet);

const driverMe = (d) => ({
  id: d.id, name: d.name, email: d.email, phone: d.phone, vehicle: d.vehicle, plate: d.plate,
  active: d.active, on_duty: d.on_duty, status: d.status, self_registered: d.self_registered,
  base: d.base_latitude === null ? null : { latitude: Number(d.base_latitude), longitude: Number(d.base_longitude) },
  radius_km: d.radius_km === null ? null : Number(d.radius_km),
  review_note: d.status === 'aprobado' ? null : d.review_note,
});

const view = (r) => ({
  ...driverRequestView(r),
  maps_url: mapsUrl(r.dropoff_address),
  waze_url: `https://waze.com/ul?q=${encodeURIComponent(r.dropoff_address)}&navigate=yes`,
  pickup_maps_url: mapsUrl(r.pickup_address),
});

router.get('/me', ah(async (req, res) => {
  const data = await withFleetDriver(req.fleetDriver.id, async (db) => {
    const cash = (await db.query(
      `SELECT coalesce(sum(cash_collected), 0)::numeric(10,2) AS total, count(*)::int AS deliveries
         FROM delivery_requests WHERE driver_id = $1 AND status = 'entregado' AND driver_cut_id IS NULL AND cash_collected > 0`,
      [req.fleetDriver.id],
    )).rows[0];
    const today = (await db.query(
      `SELECT count(*)::int AS deliveries, coalesce(sum(driver_pay), 0)::numeric(10,2) AS pay
         FROM delivery_requests WHERE driver_id = $1 AND status = 'entregado' AND delivered_at > now() - interval '18 hours'`,
      [req.fleetDriver.id],
    )).rows[0];
    return { cash_pending: cash.total, cash_deliveries: cash.deliveries, today };
  });
  res.json({ driver: driverMe(req.fleetDriver), ...data });
}));

// Zona de trabajo (NeuronPOS Delivery): epicentro y km a la redonda.
router.put('/zone', ah(async (req, res) => {
  const body = req.body || {};
  const base = readPoint(body.base, 'base');
  if (!base) throw badRequest('Marca tu epicentro en el mapa', 'MISSING_FIELD');
  const radius = Number(body.radius_km);
  const driver = await withFleetDriver(req.fleetDriver.id, async (db) => {
    const max = Number((await getMarketplaceSettings(db)).driver_max_radius_km);
    if (!Number.isFinite(radius) || radius < 1 || radius > max) throw badRequest(`El radio debe ser de 1 a ${max} km`, 'INVALID_FIELD');
    return (await db.query(
      `UPDATE fleet_drivers SET base_latitude = $2, base_longitude = $3, radius_km = $4, updated_at = now()
        WHERE id = $1 RETURNING id, name, email, phone, vehicle, plate, active, on_duty, status, self_registered,
                                base_latitude, base_longitude, radius_km, review_note`,
      [req.fleetDriver.id, base.latitude, base.longitude, Math.round(radius * 10) / 10],
    )).rows[0];
  });
  res.json({ driver: driverMe(driver) });
}));

router.post('/duty', ah(async (req, res) => {
  const onDuty = bool((req.body || {}).on_duty, 'on_duty');
  if (onDuty === undefined) throw badRequest('Indica si estas en turno', 'MISSING_FIELD');
  if (onDuty && req.fleetDriver.status !== 'aprobado') {
    throw new HttpError(403, req.fleetDriver.status === 'pendiente'
      ? 'Tu registro esta en revision; te avisamos cuando NeuronPOS lo apruebe'
      : 'Tu cuenta de repartidor no esta aprobada', 'DRIVER_NOT_APPROVED');
  }
  await withFleetDriver(req.fleetDriver.id, (db) => db.query(
    'UPDATE fleet_drivers SET on_duty = $2, updated_at = now() WHERE id = $1',
    [req.fleetDriver.id, onDuty],
  ));
  res.json({ on_duty: onDuty });
}));

router.post('/location', ah(async (req, res) => {
  const loc = readLocation(req.body);
  await withFleetDriver(req.fleetDriver.id, (db) => db.query(
    `INSERT INTO fleet_driver_locations (driver_id, latitude, longitude, accuracy_m) VALUES ($1, $2, $3, $4)
     ON CONFLICT (driver_id) DO UPDATE SET latitude = $2, longitude = $3, accuracy_m = $4, updated_at = now()`,
    [req.fleetDriver.id, loc.latitude, loc.longitude, loc.accuracy],
  ));
  res.json({ ok: true });
}));

// Solicitudes asignadas: las activas y las de las ultimas horas.
router.get('/requests', ah(async (req, res) => {
  const rows = await withFleetDriver(req.fleetDriver.id, async (db) => (await db.query(
    `SELECT * FROM delivery_requests
      WHERE driver_id = $1 AND (status IN ('asignado', 'recogido', 'en_camino') OR updated_at > now() - interval '18 hours')
      ORDER BY (status IN ('asignado', 'recogido', 'en_camino')) DESC, assigned_at DESC LIMIT 100`,
    [req.fleetDriver.id],
  )).rows);
  res.json({ requests: rows.map(view) });
}));

router.post('/requests/:id/status', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const status = oneOf(body.status, DRIVER_STATUSES, 'status');
  if (!status) throw badRequest('Indica el nuevo estado', 'MISSING_FIELD');
  const reason = str(body.reason, { field: 'reason', max: 300 }) || null;
  const request = await withFleetDriver(req.fleetDriver.id, async (db) => {
    // RLS: una solicitud que no es suya no existe para el repartidor.
    const r = await lockRequest(db, req.params.id);
    if (r.driver_id !== req.fleetDriver.id) throw notFound('Solicitud de reparto no encontrada', 'REQUEST_NOT_FOUND');
    return applyRequestTransition(db, r, status, { reason });
  });
  res.json({ request: view(request) });
}));

// Ofertas vigentes (solo un resumen, sin datos del cliente).
router.get('/offers', ah(async (req, res) => {
  const offers = await withFleetDriver(req.fleetDriver.id, async (db) => (await db.query(
    `SELECT id, request_id, summary, expires_at, created_at FROM delivery_request_offers
      WHERE driver_id = $1 AND status = 'ofrecida' AND expires_at > now() ORDER BY created_at`,
    [req.fleetDriver.id],
  )).rows);
  res.json({ offers });
}));

router.post('/offers/:id/accept', ah(async (req, res) => {
  requireUuid(req.params.id);
  // La asignacion compite con otros repartidores: corre como plataforma con
  // la oferta filtrada por este repartidor.
  const request = await withPlatform((db) => acceptOffer(db, req.params.id, req.fleetDriver.id));
  res.json({ request: view(request) });
}));

router.post('/offers/:id/decline', ah(async (req, res) => {
  requireUuid(req.params.id);
  const { rowCount } = await withFleetDriver(req.fleetDriver.id, (db) => db.query(
    `UPDATE delivery_request_offers SET status = 'rechazada', responded_at = now()
      WHERE id = $1 AND driver_id = $2 AND status = 'ofrecida'`,
    [req.params.id, req.fleetDriver.id],
  ));
  if (!rowCount) throw notFound('Oferta no encontrada', 'OFFER_NOT_FOUND');
  res.status(204).end();
}));

export default router;
