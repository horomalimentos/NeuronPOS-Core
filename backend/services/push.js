// Notificaciones push (modulo 'push'), adaptado de notificationService.js y
// pushSubscriptions.js de Horom.
//
// Los triggers de la migracion 015 encolan cada aviso en push_outbox dentro
// de la misma transaccion que cambia el pedido; aqui se mandan despues del
// COMMIT: al instante con LISTEN 'push_outbox' y, por si algo se perdio, con
// el job de respaldo. Cada aviso se reclama una sola vez (sent_at), asi que
// nunca llega dos veces.
//
// Llaves VAPID: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY del .env si existen; si
// no, se generan solas la primera vez y se guardan en platform_settings (la
// privada cifrada con PAYMENT_SECRETS_KEY).
import webpush from 'web-push';
import pool, { withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import { checkRestaurantAccess } from './access.js';
import { isModuleActive } from './billing.js';
import { decryptSecret, encryptSecret, secretsAvailable } from './secrets.js';

const VAPID_AAD = 'vapid';
let vapidCache = null;

/** { publicKey, privateKey } o null si no se pueden tener llaves. */
export async function getVapidKeys() {
  if (vapidCache) return vapidCache;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidCache = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    return vapidCache;
  }
  if (!secretsAvailable()) return null;
  vapidCache = await withPlatform(async (db) => {
    const row = (await db.query('SELECT vapid_public_key, vapid_private_enc FROM platform_settings WHERE id FOR UPDATE')).rows[0];
    if (row?.vapid_public_key && row.vapid_private_enc) {
      return { publicKey: row.vapid_public_key, privateKey: decryptSecret(row.vapid_private_enc, VAPID_AAD) };
    }
    const keys = webpush.generateVAPIDKeys();
    await db.query(
      'UPDATE platform_settings SET vapid_public_key = $1, vapid_private_enc = $2, updated_at = now() WHERE id',
      [keys.publicKey, encryptSecret(keys.privateKey, VAPID_AAD)],
    );
    return keys;
  });
  return vapidCache;
}

async function webPushSender(sub, payload) {
  const keys = await getVapidKeys();
  if (!keys) return { ok: false };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        TTL: 60 * 60,
        urgency: 'high',
        vapidDetails: { subject: env.vapidSubject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      },
    );
    return { ok: true };
  } catch (err) {
    // 404/410: el navegador ya no acepta esa suscripcion (desinstalo, borro datos...).
    return { ok: false, gone: err.statusCode === 404 || err.statusCode === 410, error: err.message };
  }
}

let sender = webPushSender;
/** Pruebas: reemplaza el envio real. fn(sub, payload) -> { ok, gone? } */
export function setPushSender(fn) {
  sender = fn || webPushSender;
}

/** Guarda (o actualiza) la suscripcion del navegador. owner: { user_id | customer_id | order_id } */
export async function saveSubscription(db, rid, subscription, owner) {
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000
    || typeof keys?.p256dh !== 'string' || keys.p256dh.length > 200
    || typeof keys?.auth !== 'string' || keys.auth.length > 100) {
    return false;
  }
  const ownerId = owner.user_id || owner.customer_id || owner.order_id;
  await db.query(
    `INSERT INTO push_subscriptions (restaurant_id, endpoint, p256dh, auth, user_id, customer_id, order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (restaurant_id, endpoint, coalesce(user_id, customer_id, order_id))
     DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [rid, endpoint, keys.p256dh, keys.auth, owner.user_id || null, owner.customer_id || null, owner.order_id || null],
  );
  // Un navegador del personal es de una sola persona: si otro usuario inicia
  // sesion en el, deja de recibir los avisos del anterior.
  if (owner.user_id) {
    await db.query(
      'DELETE FROM push_subscriptions WHERE restaurant_id = $1 AND endpoint = $2 AND user_id IS NOT NULL AND user_id <> $3',
      [rid, endpoint, ownerId],
    );
  }
  return true;
}

export async function deleteSubscription(db, rid, endpoint, owner) {
  const col = owner.user_id ? 'user_id' : owner.customer_id ? 'customer_id' : 'order_id';
  await db.query(
    `DELETE FROM push_subscriptions WHERE restaurant_id = $1 AND endpoint = $2 AND ${col} = $3`,
    [rid, String(endpoint || ''), owner[col]],
  );
}

const money = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TYPE_LABEL = { domicilio: 'A domicilio', para_llevar: 'Para llevar', comedor: 'En el local' };

function hourIn(date, tz) {
  try {
    return new Date(date).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  } catch {
    return null;
  }
}

/** Texto del aviso: { title, body, link, tag, driver } */
export function composeMessage(ev, o) {
  const n = `#${o.folio}`;
  const track = `/pedido/${o.public_token}`;
  switch (ev.kind) {
    case 'aceptado': {
      const at = o.estimated_ready_at ? hourIn(o.estimated_ready_at, o.timezone) : null;
      return {
        title: `${o.restaurant_name}: pedido ${n} aceptado`,
        body: at ? `Ya lo estamos preparando. Estará listo cerca de las ${at}.` : 'Ya lo estamos preparando.',
        link: track,
        tag: `pedido-${o.id}`,
      };
    }
    case 'listo':
      return {
        title: `¡Tu pedido ${n} está listo!`,
        body: o.order_type === 'domicilio'
          ? 'Sale pronto con el repartidor.'
          : `Ya puedes pasar por él a ${o.branch_name}.`,
        link: track,
        tag: `pedido-${o.id}`,
      };
    case 'en_camino':
      return { title: `Tu pedido ${n} va en camino`, body: `${o.restaurant_name} ya lo mandó con el repartidor.`, link: track, tag: `pedido-${o.id}` };
    case 'rechazado':
      return {
        title: `${o.restaurant_name} no pudo aceptar tu pedido ${n}`,
        body: o.cancel_reason || 'Abre el seguimiento para ver el detalle.',
        link: track,
        tag: `pedido-${o.id}`,
      };
    case 'cancelado':
      return {
        title: `Tu pedido ${n} fue cancelado`,
        body: o.cancel_reason || 'Comunícate con la sucursal si tienes dudas.',
        link: track,
        tag: `pedido-${o.id}`,
      };
    case 'nuevo_pedido':
      return {
        title: `Pedido en línea ${n} · ${money(o.total)}`,
        body: [TYPE_LABEL[o.order_type] || o.order_type, o.customer_name, o.branch_name].filter(Boolean).join(' · '),
        link: '/admin/pos?tab=linea',
        tag: `nuevo-${o.id}`,
      };
    case 'asignado':
      return {
        title: `Nuevo pedido a domicilio ${n}`,
        body: [o.customer_address, o.customer_name].filter(Boolean).join(' · ') || 'Abre la app para verlo.',
        link: '/repartidor',
        tag: `reparto-${o.id}`,
        driver: true,
      };
    default:
      return null;
  }
}

const CUSTOMER_KINDS = ['aceptado', 'listo', 'en_camino', 'rechazado', 'cancelado'];

async function recipients(db, ev, o) {
  if (CUSTOMER_KINDS.includes(ev.kind)) {
    return (await db.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE restaurant_id = $1 AND (order_id = $2 OR ($3::uuid IS NOT NULL AND customer_id = $3))`,
      [ev.restaurant_id, o.id, o.customer_id],
    )).rows;
  }
  if (ev.kind === 'nuevo_pedido') {
    // Administradores y gerentes de todas las sucursales; cajeros solo de la suya.
    return (await db.query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
         JOIN users u ON u.id = s.user_id AND u.restaurant_id = s.restaurant_id
        WHERE s.restaurant_id = $1 AND u.active
          AND (u.role IN ('admin', 'gerente')
               OR (u.role = 'cajero' AND EXISTS (
                 SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = $2)))`,
      [ev.restaurant_id, o.branch_id],
    )).rows;
  }
  if (ev.kind === 'asignado' && ev.user_id) {
    return (await db.query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
         JOIN users u ON u.id = s.user_id AND u.restaurant_id = s.restaurant_id
        WHERE s.restaurant_id = $1 AND s.user_id = $2 AND u.active`,
      [ev.restaurant_id, ev.user_id],
    )).rows;
  }
  return [];
}

/**
 * Manda los avisos pendientes. Regresa cuantos mensajes se enviaron.
 * Los de restaurantes sin el modulo (o suspendidos) se descartan.
 */
export async function dispatchPushOutbox({ now = new Date(), limit = 100 } = {}) {
  const jobs = await withPlatform(async (db) => {
    const events = (await db.query(
      `UPDATE push_outbox SET sent_at = now()
        WHERE id IN (SELECT id FROM push_outbox WHERE sent_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [limit],
    )).rows.sort((a, b) => Number(a.id) - Number(b.id));
    if (!events.length) return [];
    const rids = [...new Set(events.map((e) => e.restaurant_id))];
    const restaurants = new Map((await db.query(
      `SELECT r.*, rm.enabled, rm.started_at, rm.ends_at
         FROM restaurants r
         LEFT JOIN restaurant_modules rm ON rm.restaurant_id = r.id AND rm.module_code = 'push'
        WHERE r.id = ANY($1::uuid[])`,
      [rids],
    )).rows.map((r) => [r.id, r]));
    const out = [];
    for (const ev of events) {
      const r = restaurants.get(ev.restaurant_id);
      if (!r || checkRestaurantAccess(r, now) || !isModuleActive(r, now)) continue;
      const o = (await db.query(
        `SELECT o.id, o.folio, o.order_type, o.public_token, o.customer_id, o.customer_name, o.customer_address,
                o.branch_id, o.total, o.estimated_ready_at, o.cancel_reason,
                b.name AS branch_name, b.timezone
           FROM orders o JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
          WHERE o.id = $1 AND o.restaurant_id = $2`,
        [ev.order_id, ev.restaurant_id],
      )).rows[0];
      if (!o) continue;
      const msg = composeMessage(ev, { ...o, restaurant_name: r.name });
      if (!msg) continue;
      const subs = await recipients(db, ev, o);
      if (subs.length) out.push({ restaurantId: ev.restaurant_id, subs, payload: { ...msg, icon: r.logo_url || null } });
    }
    return out;
  });

  let sent = 0;
  const gone = [];
  for (const job of jobs) {
    for (const sub of job.subs) {
      const res = await sender(sub, job.payload);
      if (res?.ok) sent += 1;
      else if (res?.gone) gone.push(sub.id);
      else if (res?.error) console.error('[push] No se pudo enviar:', res.error);
    }
  }
  if (gone.length) {
    await withPlatform((db) => db.query('DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])', [gone]));
  }
  return sent;
}

/** Limpieza: avisos ya enviados y suscripciones de invitado de pedidos cerrados. */
export async function cleanupPush() {
  await withPlatform(async (db) => {
    await db.query("DELETE FROM push_outbox WHERE sent_at < now() - interval '3 days'");
    await db.query(
      `DELETE FROM push_subscriptions s USING orders o
        WHERE s.order_id = o.id AND s.restaurant_id = o.restaurant_id
          AND o.status IN ('pagada', 'cancelada') AND o.updated_at < now() - interval '2 days'`,
    );
  });
}

/**
 * Escucha 'push_outbox' (pg_notify de los triggers) y manda al instante.
 * Si la conexion se cae, reintenta; el job de respaldo cubre lo perdido.
 */
export function startPushListener() {
  let timer = null;
  let running = false;
  let again = false;
  const flush = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await dispatchPushOutbox();
      } while (again);
    } catch (err) {
      console.error('[push]', err.message);
    } finally {
      running = false;
    }
  };
  const connect = async () => {
    try {
      const client = await pool.connect();
      client.on('notification', () => {
        clearTimeout(timer);
        timer = setTimeout(flush, 150);
      });
      client.on('error', (err) => {
        console.error('[push] LISTEN perdio la conexion:', err.message);
        client.release(true);
        setTimeout(connect, 5000).unref();
      });
      await client.query('LISTEN push_outbox');
    } catch (err) {
      console.error('[push] No se pudo escuchar push_outbox:', err.message);
      setTimeout(connect, 15000).unref();
    }
  };
  connect();
  return flush;
}
