// Resolucion del restaurante (tenant) de cada request.
//
// Orden de prioridad:
//   1. Host: <slug>.<PLATFORM_DOMAIN> o un dominio propio (restaurants.custom_domain).
//   2. Header X-Restaurant-Slug (solo si ALLOW_SLUG_HEADER; util en desarrollo
//      o si el frontend no se sirve desde el subdominio del restaurante).
//   3. El claim `rid` del JWT (lo resuelve authenticateUser).
//
// Si el Host apunta a un restaurante, el header se ignora. Un JWT de un
// restaurante nunca sirve en otro: authenticateUser compara el claim contra
// el tenant resuelto aqui.
import pool from '../config/database.js';
import { env } from '../config/env.js';
import { SLUG_RE, notFound } from '../utils/http.js';

export const RESTAURANT_COLUMNS = `id, slug, name, custom_domain, logo_url, primary_color,
  secondary_color, status, trial_ends_at`;

/**
 * Interpreta el Host. Regresa { slug } | { customDomain } | null (host de la
 * plataforma, localhost, IP o subdominio reservado).
 */
export function parseHost(rawHost, platformDomain = env.platformDomain, reserved = env.reservedSubdomains) {
  if (!rawHost) return null;
  const host = String(rawHost).split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
  if (host === platformDomain || host === 'localhost') return null;

  const suffix = `.${platformDomain}`;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    // Solo un nivel: a.b.dominio no es un restaurante.
    if (!sub || sub.includes('.') || reserved.includes(sub) || !SLUG_RE.test(sub)) return null;
    return { slug: sub };
  }
  if (host.endsWith('.localhost')) {
    // Desarrollo: horom.localhost funciona en los navegadores sin tocar /etc/hosts.
    const sub = host.slice(0, -'.localhost'.length);
    if (!sub.includes('.') && !reserved.includes(sub) && SLUG_RE.test(sub)) return { slug: sub };
    return null;
  }
  return { customDomain: host };
}

export async function findRestaurantBySlug(slug) {
  const { rows } = await pool.query(`SELECT ${RESTAURANT_COLUMNS} FROM restaurants WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function findRestaurantById(id) {
  const { rows } = await pool.query(`SELECT ${RESTAURANT_COLUMNS} FROM restaurants WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findRestaurantByDomain(domain) {
  const { rows } = await pool.query(`SELECT ${RESTAURANT_COLUMNS} FROM restaurants WHERE custom_domain = $1`, [domain]);
  return rows[0] || null;
}

/** Llena req.tenant (o null) y req.tenantSource. Nunca responde por si solo. */
export async function resolveTenant(req, res, next) {
  try {
    req.tenant = null;
    req.tenantSource = null;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const parsed = parseHost(host);

    if (parsed?.slug) {
      req.tenant = await findRestaurantBySlug(parsed.slug);
      req.tenantSource = 'host';
    } else if (parsed?.customDomain) {
      req.tenant = await findRestaurantByDomain(parsed.customDomain);
      req.tenantSource = 'host';
    } else if (env.allowSlugHeader && req.headers['x-restaurant-slug']) {
      const slug = String(req.headers['x-restaurant-slug']).trim().toLowerCase();
      if (SLUG_RE.test(slug)) req.tenant = await findRestaurantBySlug(slug);
      req.tenantSource = 'header';
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Para rutas que no tienen sentido sin restaurante (login, sitio publico). */
export function requireTenant(req, res, next) {
  if (!req.tenant) return next(notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND'));
  next();
}
