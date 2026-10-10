// Panel NeuronPOS: administracion de NeuronPOS Delivery (fase 1). Ajustes
// (reparto 80/20, comision, distancias, tope de adeudo), tabla de envio por
// km, aprobacion de repartidores y bloqueo de fichas de restaurantes.
// Se monta dentro de routes/platform.js (ya autenticado como plataforma).
import { Router } from 'express';
import { withPlatform } from '../config/database.js';
import {
  SETTINGS_COLUMNS, getMarketplaceSettings, listFeeTiers, readFeeTiers,
} from '../services/marketplace.js';
import {
  ah, badRequest, bool, buildSet, money, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';

const router = Router();

function pct(v, field, max) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n < 0 || n > max) throw badRequest(`"${field}" debe ser de 0 a ${max}`, 'INVALID_FIELD');
  return Math.round(n * 100) / 100;
}

function km(v, field) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n <= 0 || n > 50) throw badRequest(`"${field}" debe ser de 0.1 a 50 km`, 'INVALID_FIELD');
  return Math.round(n * 100) / 100;
}

async function summary(db) {
  return (await db.query(
    `SELECT (SELECT count(*) FROM fleet_drivers WHERE status = 'pendiente')::int AS pending_drivers,
            (SELECT count(*) FROM fleet_drivers WHERE status = 'aprobado' AND active AND on_duty AND radius_km IS NOT NULL)::int AS online_drivers,
            (SELECT count(*) FROM fleet_drivers WHERE status = 'aprobado' AND radius_km IS NOT NULL)::int AS approved_drivers,
            (SELECT count(*) FROM marketplace_listings WHERE published AND NOT blocked)::int AS published_listings,
            (SELECT count(*) FROM marketplace_listings)::int AS listings`,
  )).rows[0];
}

router.get('/marketplace/settings', ah(async (req, res) => {
  const data = await withPlatform(async (db) => ({
    settings: await getMarketplaceSettings(db),
    fee_tiers: await listFeeTiers(db),
    summary: await summary(db),
  }));
  res.json(data);
}));

router.put('/marketplace/settings', ah(async (req, res) => {
  const body = req.body || {};
  const set = buildSet({
    enabled: bool(body.enabled, 'enabled'),
    driver_share_pct: pct(body.driver_share_pct, 'driver_share_pct', 100),
    food_commission_pct: pct(body.food_commission_pct, 'food_commission_pct', 50),
    max_distance_km: km(body.max_distance_km, 'max_distance_km'),
    driver_debt_limit: money(body.driver_debt_limit, { field: 'driver_debt_limit' }),
    driver_max_radius_km: km(body.driver_max_radius_km, 'driver_max_radius_km'),
  });
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const settings = await withPlatform(async (db) => (await db.query(
    `UPDATE marketplace_settings SET ${set.sql}, updated_at = now() WHERE id RETURNING ${SETTINGS_COLUMNS}`,
    set.values,
  )).rows[0]);
  res.json({ settings });
}));

router.put('/marketplace/fee-tiers', ah(async (req, res) => {
  const tiers = readFeeTiers((req.body || {}).tiers);
  const saved = await withPlatform(async (db) => {
    await db.query('DELETE FROM marketplace_fee_tiers');
    for (const t of tiers) await db.query('INSERT INTO marketplace_fee_tiers (up_to_km, fee) VALUES ($1, $2)', [t.up_to_km, t.fee]);
    return listFeeTiers(db);
  });
  res.json({ fee_tiers: saved });
}));

const DRIVER_COLUMNS = `d.id, d.name, d.phone, d.email, d.vehicle, d.plate, d.active, d.on_duty, d.status, d.self_registered,
  d.base_latitude, d.base_longitude, d.radius_km, d.review_note, d.reviewed_at, d.last_login_at, d.created_at`;

const driverView = (d) => ({
  ...d,
  base: d.base_latitude === null ? null : { latitude: Number(d.base_latitude), longitude: Number(d.base_longitude) },
  radius_km: d.radius_km === null ? null : Number(d.radius_km),
  base_latitude: undefined,
  base_longitude: undefined,
});

router.get('/marketplace/drivers', ah(async (req, res) => {
  const status = oneOf(req.query.status || undefined, ['pendiente', 'aprobado', 'rechazado', 'bloqueado'], 'status');
  const rows = await withPlatform(async (db) => (await db.query(
    `SELECT ${DRIVER_COLUMNS} FROM fleet_drivers d
      WHERE ($1::text IS NULL OR d.status = $1)
      ORDER BY (d.status = 'pendiente') DESC, d.created_at DESC LIMIT 500`,
    [status ?? null],
  )).rows);
  res.json({ drivers: rows.map(driverView) });
}));

// Aprobar, rechazar o bloquear. Un repartidor que deja de estar aprobado sale de turno.
router.post('/marketplace/drivers/:id/review', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const status = oneOf(body.status, ['aprobado', 'rechazado', 'bloqueado'], 'status');
  if (!status) throw badRequest('Indica aprobado, rechazado o bloqueado', 'MISSING_FIELD');
  const note = str(body.note, { field: 'note', max: 300 }) || null;
  if (status !== 'aprobado' && !note) throw badRequest('Escribe el motivo para el repartidor', 'MISSING_FIELD');
  const driver = await withPlatform(async (db) => {
    const { rows } = await db.query(
      `UPDATE fleet_drivers d SET status = $2, review_note = $3, reviewed_at = now(),
              on_duty = CASE WHEN $2 = 'aprobado' THEN on_duty ELSE false END, updated_at = now()
        WHERE id = $1 RETURNING ${DRIVER_COLUMNS}`,
      [req.params.id, status, note],
    );
    if (!rows[0]) throw notFound('Repartidor no encontrado', 'DRIVER_NOT_FOUND');
    return rows[0];
  });
  res.json({ driver: driverView(driver) });
}));

router.get('/marketplace/listings', ah(async (req, res) => {
  const rows = await withPlatform(async (db) => (await db.query(
    `SELECT l.restaurant_id, r.name AS restaurant_name, r.slug, r.status AS restaurant_status, r.contact_phone,
            l.branch_id, b.name AS branch_name, b.address, l.latitude, l.longitude, l.cuisine, l.published,
            l.paused_until, l.blocked, l.blocked_reason, l.created_at, l.published_at
       FROM marketplace_listings l
       JOIN restaurants r ON r.id = l.restaurant_id
       JOIN branches b ON b.id = l.branch_id
      ORDER BY l.created_at DESC LIMIT 1000`,
  )).rows);
  res.json({
    listings: rows.map((r) => ({
      ...r,
      location: r.latitude === null ? null : { latitude: Number(r.latitude), longitude: Number(r.longitude) },
      latitude: undefined,
      longitude: undefined,
    })),
  });
}));

router.post('/marketplace/listings/:branchId/block', ah(async (req, res) => {
  requireUuid(req.params.branchId);
  const body = req.body || {};
  const blocked = bool(body.blocked, 'blocked');
  if (blocked === undefined) throw badRequest('Indica si se bloquea', 'MISSING_FIELD');
  const reason = str(body.reason, { field: 'reason', max: 300 }) || null;
  if (blocked && !reason) throw badRequest('Escribe el motivo del bloqueo', 'MISSING_FIELD');
  const row = await withPlatform(async (db) => (await db.query(
    `UPDATE marketplace_listings SET blocked = $2, blocked_reason = $3, updated_at = now()
      WHERE branch_id = $1 RETURNING branch_id, blocked, blocked_reason`,
    [req.params.branchId, blocked, blocked ? reason : null],
  )).rows[0]);
  if (!row) throw notFound('Ficha no encontrada', 'LISTING_NOT_FOUND');
  res.json({ listing: row });
}));

export default router;
