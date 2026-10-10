// Zonas de entrega por distancia (modulo 'zonas_entrega'), adaptado de
// Horom: centro por sucursal y tramos { radius_km, fee }. La distancia es en
// linea recta (Haversine), igual que en Horom.
import { badRequest } from '../utils/http.js';

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** { latitude, longitude } validos, o null si no vienen. */
export function readPoint(v, field = 'location') {
  if (v === undefined || v === null) return null;
  const lat = Number(v.latitude);
  const lng = Number(v.longitude);
  if (v.latitude === null || v.latitude === undefined || v.longitude === null || v.longitude === undefined
    || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw badRequest(`"${field}" debe traer latitude y longitude validas`, 'INVALID_FIELD');
  }
  return { latitude: round6(lat), longitude: round6(lng) };
}

/** Valida y ordena los tramos: 1 a 10, radio 0.1-50 km sin repetir, tarifa 0-10,000. */
export function readTiers(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10) throw badRequest('Agrega de 1 a 10 tramos de distancia', 'INVALID_FIELD');
  const tiers = v.map((t) => ({ radius_km: Math.round(Number(t?.radius_km) * 100) / 100, fee: Math.round(Number(t?.fee) * 100) / 100 }));
  for (const t of tiers) {
    if (!Number.isFinite(t.radius_km) || t.radius_km < 0.1 || t.radius_km > 50) {
      throw badRequest('Cada tramo necesita un radio entre 0.1 y 50 km', 'INVALID_FIELD');
    }
    if (!Number.isFinite(t.fee) || t.fee < 0 || t.fee > 10000) throw badRequest('Cada tramo necesita una tarifa valida', 'INVALID_FIELD');
  }
  tiers.sort((a, b) => a.radius_km - b.radius_km);
  if (tiers.some((t, i) => i > 0 && t.radius_km === tiers[i - 1].radius_km)) {
    throw badRequest('No puede haber dos tramos con el mismo radio', 'INVALID_FIELD');
  }
  return tiers;
}

export function zoneView(z) {
  return {
    branch_id: z.branch_id,
    center: { latitude: Number(z.center_latitude), longitude: Number(z.center_longitude) },
    tiers: z.tiers.map((t) => ({ radius_km: Number(t.radius_km), fee: Number(t.fee) })),
    min_order: Number(z.min_order),
    active: z.active,
  };
}

/** Zonas activas del restaurante, por sucursal. */
export async function loadZones(db, rid, { onlyActive = true } = {}) {
  const rows = (await db.query(
    `SELECT * FROM branch_delivery_zones WHERE restaurant_id = $1 ${onlyActive ? 'AND active' : ''}`,
    [rid],
  )).rows;
  return new Map(rows.map((z) => [z.branch_id, zoneView(z)]));
}

/** Distancia y tarifa para un punto, o lanza OUT_OF_ZONE. */
export function quoteZone(zone, point) {
  const km = Math.round(haversineKm(zone.center, point) * 100) / 100;
  const tier = zone.tiers.find((t) => km <= t.radius_km);
  if (!tier) {
    const max = zone.tiers[zone.tiers.length - 1].radius_km;
    throw badRequest(`Tu domicilio está a ${km.toFixed(1)} km y esta sucursal entrega hasta ${max} km`, 'OUT_OF_ZONE');
  }
  return { distance_km: km, fee: tier.fee };
}
