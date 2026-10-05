// Reglas del checador: NIP, geocerca e IPs permitidas por sucursal. Puras
// (las rutas leen la configuracion y la checada y preguntan aqui).

export const PIN_RE = /^\d{4,6}$/;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;
// Dos checadas del mismo empleado con menos de esto se toman como repetidas.
export const DUPLICATE_SECONDS = 60;

/** Distancia en metros entre dos coordenadas (haversine). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => ((n << 8) >>> 0) + Number(p), 0) >>> 0;
}

/** Quita el prefijo ::ffff: que Node pone a las IPv4. */
export const normalizeIp = (ip) => String(ip || '').replace(/^::ffff:/i, '').trim();

/** true si la IP coincide con alguna regla (IP exacta o rango IPv4 CIDR). */
export function ipAllowed(ip, rules) {
  const clean = normalizeIp(ip);
  return rules.some((rule) => {
    const r = String(rule).trim();
    if (!r.includes('/')) return normalizeIp(r).toLowerCase() === clean.toLowerCase();
    const [base, bitsStr] = r.split('/');
    const bits = Number(bitsStr);
    const a = ipv4ToInt(clean);
    const b = ipv4ToInt(base);
    if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

export function validIpRule(rule) {
  const r = String(rule).trim();
  if (r.includes('/')) {
    const [base, bits] = r.split('/');
    return ipv4ToInt(base) !== null && /^\d{1,2}$/.test(bits) && Number(bits) <= 32;
  }
  return ipv4ToInt(r) !== null || /^[0-9a-f:]+$/i.test(r);
}

/**
 * Revisa la restriccion de la sucursal. settings: fila de hr_clock_settings
 * (o null = sin restriccion). Regresa null si se permite, o { code, error }.
 */
export function checkClockRestriction(settings, { ip, latitude, longitude }) {
  if (!settings) return null;
  if (settings.allowed_ips?.length && !ipAllowed(ip, settings.allowed_ips)) {
    return { code: 'CLOCK_IP_NOT_ALLOWED', error: 'Este dispositivo no está autorizado para checar en esta sucursal' };
  }
  if (settings.geo_enabled) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (latitude == null || longitude == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { code: 'CLOCK_LOCATION_REQUIRED', error: 'Activa la ubicación del dispositivo para checar' };
    }
    const d = distanceMeters(lat, lon, Number(settings.latitude), Number(settings.longitude));
    if (d > Number(settings.radius_meters)) {
      return { code: 'CLOCK_OUT_OF_RANGE', error: `Estás fuera de la sucursal (a ${Math.round(d)} m; máximo ${settings.radius_meters} m)` };
    }
  }
  return null;
}

/** Siguiente checada: si la ultima (de las ultimas 20 h) fue entrada, toca salida. */
export function nextKind(lastEntry, now = new Date()) {
  if (!lastEntry) return 'entrada';
  const age = now - new Date(lastEntry.occurred_at);
  if (lastEntry.kind === 'entrada' && age < 20 * 3600 * 1000) return 'salida';
  return 'entrada';
}
