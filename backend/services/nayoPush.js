// Notificaciones push de Nayo (migracion 059): cliente, restaurante y
// repartidor de la flota. Son de la plataforma, sin el modulo 'push'.
//
// Los triggers encolan en nayo_push_outbox dentro de la transaccion que
// cambia el pedido o el chat; aqui se mandan despues del COMMIT, al instante
// con LISTEN 'nayo_push' y con el job de respaldo. Cada aviso se reclama una
// sola vez (sent_at). Las mismas llaves VAPID y el mismo envio de push.js.
import pool, { withPlatform } from '../config/database.js';
import { driverCovers } from './marketplace.js';
import { sendPush } from './push.js';

const ICON = {
  cliente: '/icons/nayo-cliente-192.png',
  restaurante: '/icons/nayo-restaurante-192.png',
  repartidor: '/icons/nayo-repartidor-192.png',
};
const money = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Guarda la suscripcion del navegador. owner: { customer_id | driver_id | restaurant_id + user_id } */
export async function saveNayoSubscription(subscription, owner, linkBase = '') {
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000
    || typeof keys?.p256dh !== 'string' || keys.p256dh.length > 200
    || typeof keys?.auth !== 'string' || keys.auth.length > 100) {
    return false;
  }
  const base = ['', '/nayo', '/delivery'].includes(linkBase) ? linkBase : '';
  await withPlatform(async (db) => {
    await db.query(
      `INSERT INTO nayo_push_subscriptions (endpoint, p256dh, auth, customer_id, driver_id, restaurant_id, user_id, link_base)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (endpoint, coalesce(customer_id, driver_id, user_id))
       DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, link_base = EXCLUDED.link_base`,
      [endpoint, keys.p256dh, keys.auth, owner.customer_id || null, owner.driver_id || null,
        owner.restaurant_id || null, owner.user_id || null, base],
    );
    // Un navegador es de una persona: si otra cuenta del mismo tipo se
    // suscribe en el, la anterior deja de recibir.
    const col = owner.customer_id ? 'customer_id' : owner.driver_id ? 'driver_id' : 'user_id';
    await db.query(
      `DELETE FROM nayo_push_subscriptions WHERE endpoint = $1 AND ${col} IS NOT NULL AND ${col} <> $2`,
      [endpoint, owner[col]],
    );
  });
  return true;
}

export async function deleteNayoSubscription(endpoint, owner) {
  const col = owner.customer_id ? 'customer_id' : owner.driver_id ? 'driver_id' : 'user_id';
  await withPlatform((db) => db.query(
    `DELETE FROM nayo_push_subscriptions WHERE endpoint = $1 AND ${col} = $2`,
    [String(endpoint || ''), owner[col]],
  ));
}

/** Texto del aviso: { title, body, link, tag, driver? } */
export function composeNayoMessage(ev, m, msg) {
  const n = `#${m.folio}`;
  const track = `/pedido/${m.public_token}`;
  if (ev.kind === 'mensaje') {
    const who = msg.sender === 'cliente' ? m.customer_name || 'El cliente'
      : msg.sender === 'restaurante' ? m.restaurant_name : msg.sender_name || 'Tu repartidor';
    const link = ev.audience === 'cliente' ? track : ev.audience === 'restaurante' ? '/admin/delivery' : '/repartidor';
    return { title: `${who} · pedido ${n}`, body: clip(msg.body), link, tag: `chat-${m.id}` };
  }
  switch (`${ev.audience}:${ev.kind}`) {
    case 'cliente:aceptado':
      return { title: `${m.restaurant_name} aceptó tu pedido`, body: 'Ya lo están preparando. Te avisamos cuando vaya en camino.', link: track, tag: `pedido-${m.id}` };
    case 'cliente:en_camino':
      return { title: 'Tu pedido va en camino', body: `${m.driver_name || 'Tu repartidor'} ya lo recogió en ${m.restaurant_name}.`, link: track, tag: `pedido-${m.id}` };
    case 'cliente:entregado':
      return { title: 'Pedido entregado', body: `¡Buen provecho! Gracias por pedir a ${m.restaurant_name} en Nayo.`, link: track, tag: `pedido-${m.id}` };
    case 'cliente:rechazado':
      return { title: `${m.restaurant_name} no pudo aceptar tu pedido`, body: m.cancel_reason || 'Abre el seguimiento para ver el detalle.', link: track, tag: `pedido-${m.id}` };
    case 'cliente:cancelado':
      return { title: 'Tu pedido fue cancelado', body: m.cancel_reason || 'Abre el seguimiento para ver el detalle.', link: track, tag: `pedido-${m.id}` };
    case 'restaurante:nuevo_pedido':
      return {
        title: `Nuevo pedido de Nayo ${n} · ${money(m.food_total)}`,
        body: [m.customer_name, m.branch_name, m.payment_method === 'tarjeta' ? 'pagado con tarjeta' : 'efectivo'].filter(Boolean).join(' · '),
        link: '/admin/delivery',
        tag: `nayo-${m.id}`,
      };
    case 'repartidores:disponible':
      return {
        title: `Pedido disponible · ${money(m.driver_share)}`,
        body: `${m.restaurant_name} · ${Number(m.distance_km).toFixed(1)} km de entrega`,
        link: '/repartidor',
        tag: `disponible-${m.id}`,
        driver: true,
      };
    case 'repartidor:cancelado':
      return { title: `Se canceló el pedido ${n}`, body: m.cancel_reason || m.restaurant_name, link: '/repartidor', tag: `reparto-${m.id}`, driver: true };
    default:
      return null;
  }
}

async function recipients(db, ev, m) {
  const cols = 's.id, s.endpoint, s.p256dh, s.auth, s.link_base';
  if (ev.audience === 'cliente') {
    if (!m.customer_id) return [];
    return (await db.query(`SELECT ${cols} FROM nayo_push_subscriptions s WHERE s.customer_id = $1`, [m.customer_id])).rows;
  }
  if (ev.audience === 'restaurante') {
    // Administradores y gerentes de todas las sucursales; cajeros solo de la suya.
    return (await db.query(
      `SELECT ${cols} FROM nayo_push_subscriptions s
         JOIN users u ON u.id = s.user_id AND u.restaurant_id = s.restaurant_id
        WHERE s.restaurant_id = $1 AND u.active
          AND (u.role IN ('admin', 'gerente')
               OR (u.role = 'cajero' AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = $2)))`,
      [m.restaurant_id, m.branch_id],
    )).rows;
  }
  if (ev.audience === 'repartidor') {
    return (await db.query(
      `SELECT ${cols} FROM nayo_push_subscriptions s JOIN fleet_drivers d ON d.id = s.driver_id
        WHERE s.driver_id = $1 AND d.active`,
      [ev.driver_id],
    )).rows;
  }
  if (ev.audience === 'repartidores') {
    // Aprobados, en turno y cuyo epicentro + radio cubre el restaurante.
    if (m.driver_id || m.r_lat === null) return [];
    const point = { latitude: Number(m.r_lat), longitude: Number(m.r_lng) };
    const rows = (await db.query(
      `SELECT ${cols}, d.base_latitude, d.base_longitude, d.radius_km FROM nayo_push_subscriptions s
         JOIN fleet_drivers d ON d.id = s.driver_id
        WHERE d.active AND d.status = 'aprobado' AND d.on_duty`,
    )).rows;
    return rows.filter((d) => driverCovers(d, point));
  }
  return [];
}

/** Manda los avisos pendientes de Nayo. Regresa cuantos mensajes se enviaron. */
export async function dispatchNayoPush({ limit = 100 } = {}) {
  const jobs = await withPlatform(async (db) => {
    const events = (await db.query(
      `UPDATE nayo_push_outbox SET sent_at = now()
        WHERE id IN (SELECT id FROM nayo_push_outbox WHERE sent_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [limit],
    )).rows.sort((a, b) => Number(a.id) - Number(b.id));
    const out = [];
    for (const ev of events) {
      const m = (await db.query(
        `SELECT m.*, o.folio, r.name AS restaurant_name, b.name AS branch_name, d.name AS driver_name,
                l.latitude AS r_lat, l.longitude AS r_lng
           FROM marketplace_orders m
           JOIN orders o ON o.id = m.order_id
           JOIN restaurants r ON r.id = m.restaurant_id
           JOIN branches b ON b.id = m.branch_id
           LEFT JOIN fleet_drivers d ON d.id = m.driver_id
           LEFT JOIN marketplace_listings l ON l.branch_id = m.branch_id
          WHERE m.id = $1`,
        [ev.marketplace_order_id],
      )).rows[0];
      if (!m) continue;
      const msg = ev.message_id
        ? (await db.query('SELECT sender, sender_name, body FROM marketplace_messages WHERE id = $1', [ev.message_id])).rows[0]
        : null;
      if (ev.kind === 'mensaje' && !msg) continue;
      const text = composeNayoMessage(ev, m, msg);
      if (!text) continue;
      const subs = await recipients(db, ev, m);
      const app = ev.audience === 'repartidores' ? 'repartidor' : ev.audience;
      for (const s of subs) {
        // El cliente en neuronpos.app abre /nayo/pedido/...
        const link = app === 'cliente' ? `${s.link_base}${text.link}` : text.link;
        out.push({ sub: s, payload: { ...text, link, icon: ICON[app], badge: `/icons/nayo-${app}-badge.png` } });
      }
    }
    return out;
  });

  let sent = 0;
  const gone = [];
  for (const job of jobs) {
    const res = await sendPush(job.sub, job.payload);
    if (res?.ok) sent += 1;
    else if (res?.gone) gone.push(job.sub.id);
    else if (res?.error) console.error('[nayo push] No se pudo enviar:', res.error);
  }
  if (gone.length) {
    await withPlatform((db) => db.query('DELETE FROM nayo_push_subscriptions WHERE id = ANY($1::uuid[])', [gone]));
  }
  return sent;
}

/**
 * Aviso de prueba para el propio cliente (boton "Probar aviso" de su cuenta):
 * le llega a todos sus dispositivos suscritos. Regresa cuantos se enviaron.
 */
export async function sendNayoTestPush(customerId) {
  const subs = await withPlatform(async (db) => (await db.query(
    'SELECT id, endpoint, p256dh, auth, link_base FROM nayo_push_subscriptions WHERE customer_id = $1',
    [customerId],
  )).rows);
  let sent = 0;
  const gone = [];
  for (const s of subs) {
    const res = await sendPush(s, {
      title: 'Avisos de Nayo activados',
      body: 'Así te avisaremos cuando tu pedido sea aceptado, vaya en camino o llegue.',
      link: s.link_base || '/',
      tag: 'nayo-prueba',
      icon: ICON.cliente,
      badge: '/icons/nayo-cliente-badge.png',
    });
    if (res?.ok) sent += 1;
    else if (res?.gone) gone.push(s.id);
    else if (res?.error) console.error('[nayo push] No se pudo enviar la prueba:', res.error);
  }
  if (gone.length) {
    await withPlatform((db) => db.query('DELETE FROM nayo_push_subscriptions WHERE id = ANY($1::uuid[])', [gone]));
  }
  return { devices: subs.length, sent };
}

export async function cleanupNayoPush() {
  await withPlatform((db) => db.query("DELETE FROM nayo_push_outbox WHERE sent_at < now() - interval '3 days'"));
}

/** LISTEN 'nayo_push': manda al instante; si la conexion se cae, reintenta. */
export function startNayoPushListener() {
  let timer = null;
  let running = false;
  let again = false;
  const flush = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await dispatchNayoPush();
      } while (again);
    } catch (err) {
      console.error('[nayo push]', err.message);
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
        console.error('[nayo push] LISTEN perdio la conexion:', err.message);
        client.release(true);
        setTimeout(connect, 5000).unref();
      });
      await client.query('LISTEN nayo_push');
    } catch (err) {
      console.error('[nayo push] No se pudo escuchar nayo_push:', err.message);
      setTimeout(connect, 15000).unref();
    }
  };
  connect();
  return flush;
}
