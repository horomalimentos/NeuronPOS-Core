// Avisos push de la app Panel (dueno de la plataforma, migracion 063):
// restaurante o repartidor nuevo esperando revision. Mismas llaves VAPID y
// mismo envio que push.js.
import { withPlatform } from '../config/database.js';
import { sendPush } from './push.js';

const ICON = '/icons/panel-192.png';
const BADGE = '/icons/panel-badge.png';

export async function savePlatformSubscription(subscription, adminId) {
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000
    || typeof keys?.p256dh !== 'string' || keys.p256dh.length > 200
    || typeof keys?.auth !== 'string' || keys.auth.length > 100) {
    return false;
  }
  await withPlatform((db) => db.query(
    `INSERT INTO platform_push_subscriptions (endpoint, p256dh, auth, admin_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, admin_id = EXCLUDED.admin_id`,
    [endpoint, keys.p256dh, keys.auth, adminId],
  ));
  return true;
}

export async function deletePlatformSubscription(endpoint, adminId) {
  await withPlatform((db) => db.query(
    'DELETE FROM platform_push_subscriptions WHERE endpoint = $1 AND admin_id = $2',
    [String(endpoint || ''), adminId],
  ));
}

/** Texto del aviso para el Panel. kind: 'restaurante' | 'repartidor' */
export function composePlatformMessage(kind, name) {
  if (kind === 'restaurante') {
    return { title: 'Nuevo restaurante en Nayo', body: `${name} se registró y espera tu aprobación.`, link: '/panel/delivery', tag: 'panel-restaurante' };
  }
  return { title: 'Nuevo repartidor en Nayo', body: `${name} se registró y espera tu aprobación.`, link: '/panel/delivery', tag: 'panel-repartidor' };
}

/** Manda el aviso a todos los administradores activos con avisos activados. */
export async function notifyPlatform(kind, name) {
  const payload = { ...composePlatformMessage(kind, name), icon: ICON, badge: BADGE };
  const subs = await withPlatform(async (db) => (await db.query(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM platform_push_subscriptions s
       JOIN platform_admins a ON a.id = s.admin_id WHERE a.active`,
  )).rows);
  let sent = 0;
  const gone = [];
  for (const s of subs) {
    const res = await sendPush(s, payload);
    if (res?.ok) sent += 1;
    else if (res?.gone) gone.push(s.id);
    else if (res?.error) console.error('[panel push] No se pudo enviar:', res.error);
  }
  if (gone.length) {
    await withPlatform((db) => db.query('DELETE FROM platform_push_subscriptions WHERE id = ANY($1::uuid[])', [gone]));
  }
  return sent;
}
