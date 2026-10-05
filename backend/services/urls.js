// URLs publicas: a donde Clip regresa al cliente y a donde manda webhooks.
import { env } from '../config/env.js';

/** Sitio del restaurante: su dominio propio o <slug>.<PLATFORM_DOMAIN>. */
export function restaurantSiteUrl(r) {
  if (r.custom_domain) return `https://${r.custom_domain}`;
  return env.restaurantUrlTemplate
    .replaceAll('{slug}', r.slug)
    .replaceAll('{domain}', env.platformDomain)
    .replace(/\/+$/, '');
}

export const platformWebhookUrl = () => `${env.publicApiUrl}/api/webhooks/clip/plataforma`;

/** Por restaurante: el id no cambia aunque cambie el slug (tambien acepta el slug). */
export const restaurantWebhookUrl = (r) => `${env.publicApiUrl}/api/webhooks/clip/r/${r.id}`;
