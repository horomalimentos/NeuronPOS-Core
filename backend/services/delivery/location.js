// Ubicacion que manda la app del repartidor (geolocalizacion del navegador).
import { badRequest } from '../../utils/http.js';

/** Coordenadas validas (latitude, longitude) y precision opcional en metros. */
export function readLocation(body = {}) {
  const num = (v) => (v === null || v === '' || typeof v === 'boolean' ? NaN : Number(v));
  const lat = num(body.latitude);
  const lng = num(body.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw badRequest('Ubicacion invalida', 'INVALID_LOCATION');
  }
  const acc = body.accuracy === undefined || body.accuracy === null ? null : num(body.accuracy);
  return {
    latitude: Math.round(lat * 1e6) / 1e6,
    longitude: Math.round(lng * 1e6) / 1e6,
    accuracy: Number.isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc * 10) / 10, 9999999) : null,
  };
}
