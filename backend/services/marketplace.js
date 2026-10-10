// NeuronPOS Delivery: reglas de la plataforma de pedidos (ajustes, tarifas
// por km, cobertura de repartidores) y alta de restaurantes. Las funciones
// puras (feeForDistance, splitDeliveryFee, driverCovers) se prueban solas;
// las demas reciben un `db` de withPlatform.
import { env } from '../config/env.js';
import { SLUG_RE, badRequest } from '../utils/http.js';
import { haversineKm } from './deliveryZones.js';

const round2 = (n) => Math.round(n * 100) / 100;

export const SETTINGS_COLUMNS = `enabled, driver_share_pct, food_commission_pct, max_distance_km,
  driver_debt_limit, driver_max_radius_km, updated_at`;

export async function getMarketplaceSettings(db) {
  const row = (await db.query(`SELECT ${SETTINGS_COLUMNS} FROM marketplace_settings WHERE id`)).rows[0];
  return row || {
    enabled: false, driver_share_pct: '80.00', food_commission_pct: '0.00', max_distance_km: '10.00',
    driver_debt_limit: '300.00', driver_max_radius_km: '15.00', updated_at: null,
  };
}

export async function listFeeTiers(db) {
  const { rows } = await db.query('SELECT up_to_km, fee FROM marketplace_fee_tiers ORDER BY up_to_km');
  return rows.map((r) => ({ up_to_km: Number(r.up_to_km), fee: Number(r.fee) }));
}

/** Valida y ordena la tabla de envio: 1 a 12 tramos, 0.1-50 km sin repetir, tarifa 0-10,000. */
export function readFeeTiers(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) throw badRequest('Agrega de 1 a 12 tramos de distancia', 'INVALID_FIELD');
  const tiers = v.map((t) => ({ up_to_km: round2(Number(t?.up_to_km)), fee: round2(Number(t?.fee)) }));
  for (const t of tiers) {
    if (!Number.isFinite(t.up_to_km) || t.up_to_km < 0.1 || t.up_to_km > 50) {
      throw badRequest('Cada tramo necesita una distancia entre 0.1 y 50 km', 'INVALID_FIELD');
    }
    if (!Number.isFinite(t.fee) || t.fee < 0 || t.fee > 10000) throw badRequest('Cada tramo necesita un costo valido', 'INVALID_FIELD');
  }
  tiers.sort((a, b) => a.up_to_km - b.up_to_km);
  if (tiers.some((t, i) => i > 0 && t.up_to_km === tiers[i - 1].up_to_km)) {
    throw badRequest('No puede haber dos tramos con la misma distancia', 'INVALID_FIELD');
  }
  return tiers;
}

/**
 * Costo de envio para una distancia: el primer tramo que la cubre. null si
 * es mas lejos que el ultimo tramo o que la distancia maxima.
 */
export function feeForDistance(tiers, km, maxKm = Infinity) {
  if (!Number.isFinite(km) || km < 0 || km > Number(maxKm)) return null;
  const sorted = [...tiers].sort((a, b) => a.up_to_km - b.up_to_km);
  const tier = sorted.find((t) => km <= Number(t.up_to_km));
  return tier ? round2(Number(tier.fee)) : null;
}

/** Reparto del envio: { driver, platform } (lo del repartidor redondeado; el resto a NeuronPOS). */
export function splitDeliveryFee(fee, driverSharePct) {
  const driver = round2((Number(fee) * Number(driverSharePct)) / 100);
  return { driver, platform: round2(Number(fee) - driver) };
}

/** El repartidor cubre el punto si esta dentro del radio de su epicentro. */
export function driverCovers(driver, point) {
  if (driver.base_latitude === null || driver.base_latitude === undefined || !driver.radius_km) return false;
  const base = { latitude: Number(driver.base_latitude), longitude: Number(driver.base_longitude) };
  return haversineKm(base, point) <= Number(driver.radius_km);
}

/**
 * Repartidores aprobados, activos y en turno cuyo epicentro + radio cubre el
 * punto (el restaurante). SQL con Haversine para no traer a todos.
 */
export async function coveringDrivers(db, point) {
  const { rows } = await db.query(
    `SELECT id, name, base_latitude, base_longitude, radius_km FROM fleet_drivers
      WHERE active AND status = 'aprobado' AND on_duty AND base_latitude IS NOT NULL AND radius_km IS NOT NULL
        AND 2 * 6371 * asin(sqrt(
              power(sin(radians(base_latitude - $1) / 2), 2)
              + cos(radians($1)) * cos(radians(base_latitude)) * power(sin(radians(base_longitude - $2) / 2), 2)
            )) <= radius_km`,
    [point.latitude, point.longitude],
  );
  return rows;
}

const SLUG_BASE_MAX = 40;

/** 'Tacos Doña Pepa' -> 'tacos-dona-pepa' (sin acentos ni simbolos). */
export function slugify(name) {
  const s = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX).replace(/-+$/g, '');
  return s || 'restaurante';
}

/** Un slug libre a partir del nombre: tacos-pepa, tacos-pepa-2, ... */
export async function freeSlug(db, name) {
  const base = slugify(name);
  const taken = new Set((await db.query(
    "SELECT slug FROM restaurants WHERE slug = $1 OR slug LIKE $1 || '-%'",
    [base],
  )).rows.map((r) => r.slug));
  for (let i = 1; i < 1000; i += 1) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(slug) && !env.reservedSubdomains.includes(slug) && SLUG_RE.test(slug)) return slug;
  }
  throw badRequest('No se pudo generar la direccion del restaurante; cambia el nombre', 'SLUG_TAKEN');
}
