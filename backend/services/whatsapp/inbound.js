// Webhook de WhatsApp (un solo URL para toda la plataforma): verifica la
// firma de Meta, encuentra el restaurante por el phone_number_id, guarda
// cada mensaje una sola vez y lo pasa al bot (o al panel, si la
// conversacion la atiende una persona). Las respuestas se mandan despues
// del COMMIT, en orden, una conversacion a la vez.
import crypto from 'node:crypto';
import { withPlatform, withTenant } from '../../config/database.js';
import { env } from '../../config/env.js';
import { findRestaurantById } from '../../middleware/tenant.js';
import { loadModuleRow } from '../../middleware/requireModule.js';
import { checkModuleAccess } from '../access.js';
import { moduleState } from '../onlineOrders.js';
import { runBot } from './bot.js';
import { appSecretFor, logOutbound, transmit } from './client.js';

// Una conversacion atendida por una persona vuelve al bot tras 12 h sin mensajes.
const HUMAN_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** GET de verificacion de Meta: regresa el challenge o null. */
export async function verifyChallenge(query) {
  const token = String(query['hub.verify_token'] || '');
  if (query['hub.mode'] !== 'subscribe' || !token || token.length > 200) return null;
  if (env.whatsappVerifyToken && token === env.whatsappVerifyToken) return String(query['hub.challenge'] ?? '');
  const ok = await withPlatform((db) => db.query('SELECT 1 FROM whatsapp_settings WHERE verify_token = $1', [token]));
  return ok.rowCount ? String(query['hub.challenge'] ?? '') : null;
}

function validSignature(raw, header, secret) {
  if (!secret || !raw || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Lo que el bot entiende de cada tipo de mensaje. */
export function extractInput(m) {
  switch (m.type) {
    case 'text':
      return { kind: 'text', text: m.text?.body || '', body: m.text?.body || '' };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply;
      if (r) return { kind: 'reply', id: String(r.id), text: r.title, body: r.title };
      if (m.interactive?.nfm_reply) return { kind: 'media', body: '[formulario]' };
      return { kind: 'media', body: '[interactivo]' };
    }
    case 'button':
      return { kind: 'text', text: m.button?.text || '', body: m.button?.text || '' };
    case 'location': {
      const l = m.location || {};
      return {
        kind: 'location',
        location: { latitude: Number(l.latitude), longitude: Number(l.longitude), address: l.address || l.name || null },
        body: `[ubicación] ${[l.name, l.address].filter(Boolean).join(', ') || `${l.latitude}, ${l.longitude}`}`,
      };
    }
    default: {
      const media = m[m.type] || {};
      const label = { image: 'imagen', audio: 'audio', video: 'video', document: 'documento', sticker: 'sticker' }[m.type] || m.type;
      return { kind: 'media', body: [`[${label}]`, media.caption].filter(Boolean).join(' ') };
    }
  }
}

/** Modulos que el bot necesita para tomar pedidos. */
async function botModules(tenant) {
  const order = await moduleState(tenant);
  const portal = !checkModuleAccess(tenant, 'portal', await loadModuleRow(tenant.id, 'portal'));
  return { ordering: portal && order.pos, delivery: !order.domicilios, zonas: order.zonas, order };
}

async function processMessage({ settings, tenant, contactName, message, now }) {
  const rid = tenant.id;
  const input = extractInput(message);
  const mods = input.kind === 'media' ? null : await botModules(tenant);
  const out = await withTenant(rid, async (db) => {
    await db.query(
      `INSERT INTO whatsapp_conversations (restaurant_id, wa_id, profile_name) VALUES ($1, $2, $3)
       ON CONFLICT (restaurant_id, wa_id) DO UPDATE SET profile_name = coalesce(EXCLUDED.profile_name, whatsapp_conversations.profile_name)`,
      [rid, message.from, contactName ? String(contactName).slice(0, 120) : null],
    );
    const conv = (await db.query(
      'SELECT * FROM whatsapp_conversations WHERE restaurant_id = $1 AND wa_id = $2 FOR UPDATE',
      [rid, message.from],
    )).rows[0];
    const saved = await db.query(
      `INSERT INTO whatsapp_messages (restaurant_id, conversation_id, direction, sender, type, body, payload, wa_message_id, status)
       VALUES ($1, $2, 'in', 'cliente', $3, $4, $5, $6, 'recibido')
       ON CONFLICT (restaurant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING RETURNING id`,
      [rid, conv.id, String(message.type).slice(0, 30), input.body.slice(0, 4000), message, message.id],
    );
    if (!saved.rowCount) return null; // Meta repitio el webhook.

    let next = { state: conv.state, context: conv.context, mode: conv.mode, needs_attention: conv.needs_attention, replies: [] };
    const lastInbound = conv.last_inbound_at ? new Date(conv.last_inbound_at) : null;
    if (conv.mode === 'humano' && lastInbound && now - lastInbound > HUMAN_TIMEOUT_MS) {
      conv.mode = 'bot';
      conv.needs_attention = false;
      conv.state = 'inicio';
    }
    if (conv.mode === 'humano' || !settings.bot_enabled) {
      next = { ...next, mode: conv.mode === 'humano' ? 'humano' : conv.mode, needs_attention: true };
    } else {
      // Media sin modulos: el bot solo contesta que no entiende.
      next = await runBot(db, { tenant, settings, conversation: conv, mods: mods || { ordering: false }, now }, input);
    }
    await db.query(
      `UPDATE whatsapp_conversations
          SET state = $3, context = $4, mode = $5, needs_attention = $6, unread = unread + 1,
              last_inbound_at = $7, last_message_at = $7, last_message_preview = $8
        WHERE id = $1 AND restaurant_id = $2`,
      [conv.id, rid, next.state, next.context, next.mode, next.needs_attention, now, input.body.slice(0, 200)],
    );
    return { conv, replies: next.replies };
  });
  if (!out?.replies.length) return;
  for (const reply of out.replies) {
    const result = await transmit(settings, out.conv.wa_id, reply);
    await withTenant(rid, (db) => logOutbound(db, out.conv, reply, result));
  }
}

const STATUS = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };
const RANK = { enviado: 1, entregado: 2, leido: 3, fallido: 4 };

async function processStatus(rid, st) {
  const status = STATUS[st.status];
  if (!status || !st.id) return;
  const error = st.errors?.[0] ? `${st.errors[0].code}: ${st.errors[0].title || st.errors[0].message || ''}`.slice(0, 500) : null;
  await withTenant(rid, (db) => db.query(
    `UPDATE whatsapp_messages SET status = $3, error = coalesce($4, error)
      WHERE restaurant_id = $1 AND wa_message_id = $2 AND direction = 'out'
        AND (CASE status WHEN 'enviado' THEN 1 WHEN 'entregado' THEN 2 WHEN 'leido' THEN 3 WHEN 'fallido' THEN 4 ELSE 0 END) < $5`,
    [rid, st.id, status, error, RANK[status]],
  ));
}

// Una conversacion a la vez y en orden de llegada.
const chains = new Map();
function enqueue(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn).catch((err) => console.error('[whatsapp]', err.message));
  chains.set(key, run);
  run.finally(() => { if (chains.get(key) === run) chains.delete(key); });
  return run;
}

/** Pruebas: espera a que terminen todos los mensajes en proceso. */
export async function whatsappIdle() {
  while (chains.size) await Promise.all([...chains.values()]);
}

/**
 * POST del webhook. Regresa el status HTTP: 401 si la firma no es valida.
 * Lo valido se procesa en segundo plano (Meta espera respuesta rapida).
 */
export async function handleWebhook(raw, signature, { now = () => new Date() } = {}) {
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return 400;
  }
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return 200;
  const values = body.entry.flatMap((e) => (e.changes || []).filter((c) => c.field === 'messages').map((c) => c.value || {}));
  const ids = [...new Set(values.map((v) => v.metadata?.phone_number_id).filter(Boolean).map(String))];
  if (!ids.length) return 200;
  const rows = (await withPlatform((db) => db.query(
    'SELECT * FROM whatsapp_settings WHERE phone_number_id = ANY($1::text[])', [ids],
  ))).rows;
  const byNumber = new Map(rows.map((s) => [s.phone_number_id, s]));
  // Todos los numeros del mismo envio vienen de la misma app: si una firma falla, se rechaza.
  for (const s of rows) {
    if (!validSignature(raw, signature, appSecretFor(s))) return 401;
  }
  if (!rows.length && !validSignature(raw, signature, env.whatsappAppSecret)) return 401;

  for (const value of values) {
    const settings = byNumber.get(String(value.metadata?.phone_number_id));
    if (!settings) continue;
    const rid = settings.restaurant_id;
    for (const st of value.statuses || []) void enqueue(`status:${rid}`, () => processStatus(rid, st));
    if (!value.messages?.length || !settings.enabled) continue;
    const tenant = await findRestaurantById(rid);
    const denied = checkModuleAccess(tenant, 'whatsapp', await loadModuleRow(rid, 'whatsapp'));
    if (denied) continue;
    const names = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
    for (const message of value.messages) {
      if (!message?.from || !/^[0-9]{6,20}$/.test(message.from) || !message.id) continue;
      void enqueue(`${rid}:${message.from}`, () => processMessage({
        settings, tenant, contactName: names.get(message.from), message, now: now(),
      }));
    }
  }
  return 200;
}
