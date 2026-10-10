// Bot de WhatsApp (modulo 'whatsapp'): configuracion del numero (solo
// administrador) y panel de conversaciones (administrador, gerente y cajero):
// ver el chat, contestar como persona y devolver la conversacion al bot.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { secretsAvailable } from '../services/secrets.js';
import { encryptAppSecret, encryptToken, logOutbound, transmit } from '../services/whatsapp/client.js';
import * as M from '../services/whatsapp/messages.js';
import {
  HttpError, ah, badRequest, bool, notFound, requireUuid, str,
} from '../utils/http.js';

const router = Router();
router.use(authenticateUser, requireModule('whatsapp'));
const adminOnly = requireRole('admin');
const staff = requireRole('admin', 'gerente', 'cajero');

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const whatsappWebhookUrl = () => `${env.publicApiUrl}/api/webhooks/whatsapp`;

async function loadSettings(db, rid) {
  return (await db.query('SELECT * FROM whatsapp_settings WHERE restaurant_id = $1', [rid])).rows[0] || null;
}

function settingsView(s) {
  return {
    enabled: s?.enabled ?? false,
    phone_number_id: s?.phone_number_id ?? null,
    display_phone: s?.display_phone ?? null,
    has_access_token: Boolean(s?.access_token_enc),
    has_app_secret: Boolean(s?.app_secret_enc),
    platform_app_secret: Boolean(env.whatsappAppSecret),
    verify_token: s?.verify_token ?? null,
    bot_enabled: s?.bot_enabled ?? true,
    welcome_text: s?.welcome_text ?? null,
    faqs: s?.faqs ?? [],
    notify_status: s?.notify_status ?? true,
    webhook_url: whatsappWebhookUrl(),
    secrets_available: secretsAvailable(),
  };
}

function readFaqs(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 5) throw badRequest('Máximo 5 preguntas frecuentes', 'INVALID_FIELD');
  return value.map((f, i) => ({
    question: str(f?.question, { field: `faqs[${i}].question`, required: true, max: 24 }),
    answer: str(f?.answer, { field: `faqs[${i}].answer`, required: true, max: 1000 }),
  }));
}

router.get('/settings', adminOnly, ah(async (req, res) => {
  res.json({ settings: settingsView(await withTenant(req.tenant.id, (db) => loadSettings(db, req.tenant.id))) });
}));

router.put('/settings', adminOnly, ah(async (req, res) => {
  const b = req.body || {};
  const rid = req.tenant.id;
  const phoneNumberId = str(b.phone_number_id, { field: 'phone_number_id', max: 30 });
  if (phoneNumberId && !/^[0-9]{5,30}$/.test(phoneNumberId)) throw badRequest('El Phone number ID son solo números', 'INVALID_FIELD');
  const token = str(b.access_token, { field: 'access_token', max: 1000 });
  const appSecret = str(b.app_secret, { field: 'app_secret', max: 200 });
  if ((token || appSecret) && !secretsAvailable()) {
    throw new HttpError(503, 'Falta PAYMENT_SECRETS_KEY en el servidor para guardar llaves', 'SECRETS_UNAVAILABLE');
  }
  const f = {
    enabled: bool(b.enabled, 'enabled'),
    phone_number_id: phoneNumberId,
    display_phone: str(b.display_phone, { field: 'display_phone', max: 30 }),
    access_token_enc: token ? encryptToken(rid, token) : undefined,
    app_secret_enc: b.app_secret === null ? null : appSecret ? encryptAppSecret(rid, appSecret) : undefined,
    bot_enabled: bool(b.bot_enabled, 'bot_enabled'),
    welcome_text: str(b.welcome_text, { field: 'welcome_text', max: 600 }),
    faqs: readFaqs(b.faqs),
    notify_status: bool(b.notify_status, 'notify_status'),
  };
  const entries = Object.entries(f).filter(([, v]) => v !== undefined);
  const settings = await withTenant(rid, async (db) => {
    await db.query('INSERT INTO whatsapp_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [rid]);
    if (entries.length) {
      await db.query(
        `UPDATE whatsapp_settings SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE restaurant_id = $1`,
        [rid, ...entries.map(([k, v]) => (k === 'faqs' ? JSON.stringify(v) : v))],
      );
    }
    return loadSettings(db, rid);
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, 'Ese número ya está conectado en otro restaurante', 'PHONE_TAKEN');
    if (err.code === '23514') throw badRequest('Para activar el bot captura el Phone number ID y el token de acceso', 'WHATSAPP_INCOMPLETE');
    throw err;
  });
  res.json({ settings: settingsView(settings) });
}));

// --- Conversaciones ---

const CONV_COLS = `id, wa_id, profile_name, mode, needs_attention, state, unread, last_inbound_at, last_message_at,
  last_message_preview, created_at`;

router.get('/pending-count', staff, ah(async (req, res) => {
  const n = await withTenant(req.tenant.id, async (db) => Number((await db.query(
    'SELECT count(*) FROM whatsapp_conversations WHERE restaurant_id = $1 AND needs_attention', [req.tenant.id],
  )).rows[0].count));
  res.json({ count: n });
}));

router.get('/conversations', staff, ah(async (req, res) => {
  const params = [req.tenant.id];
  let where = 'restaurant_id = $1';
  if (req.query.filter === 'atencion') where += ' AND needs_attention';
  else if (req.query.filter === 'humano') where += " AND mode = 'humano'";
  const q = str(req.query.q, { field: 'q', max: 60 });
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '')}%`);
    where += ` AND (profile_name ILIKE $${params.length} OR wa_id LIKE $${params.length})`;
  }
  const conversations = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${CONV_COLS} FROM whatsapp_conversations WHERE ${where} ORDER BY needs_attention DESC, last_message_at DESC LIMIT 200`,
    params,
  )).rows);
  res.json({ conversations });
}));

async function loadConversation(db, rid, id, { lock = false } = {}) {
  const conv = (await db.query(
    `SELECT * FROM whatsapp_conversations WHERE id = $1 AND restaurant_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [requireUuid(id), rid],
  )).rows[0];
  if (!conv) throw notFound('Conversación no encontrada', 'CONVERSATION_NOT_FOUND');
  return conv;
}

const view = (c, now = new Date()) => ({
  id: c.id, wa_id: c.wa_id, profile_name: c.profile_name, mode: c.mode, needs_attention: c.needs_attention, state: c.state,
  unread: c.unread, last_inbound_at: c.last_inbound_at, last_message_at: c.last_message_at, created_at: c.created_at,
  // WhatsApp solo deja escribir libremente 24 h despues del ultimo mensaje del cliente.
  window_open: Boolean(c.last_inbound_at && now - new Date(c.last_inbound_at) < WINDOW_MS),
  cart_items: Array.isArray(c.context?.cart) ? c.context.cart.length : 0,
});

router.get('/conversations/:id', staff, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const conv = await loadConversation(db, req.tenant.id, req.params.id);
    await db.query('UPDATE whatsapp_conversations SET unread = 0 WHERE id = $1 AND restaurant_id = $2', [conv.id, req.tenant.id]);
    const messages = (await db.query(
      `SELECT m.id, m.direction, m.sender, m.type, m.body, m.status, m.error, m.created_at, u.name AS sent_by_name
         FROM (SELECT * FROM whatsapp_messages WHERE restaurant_id = $1 AND conversation_id = $2
                ORDER BY created_at DESC LIMIT 300) m
         LEFT JOIN users u ON u.id = m.sent_by AND u.restaurant_id = m.restaurant_id
        ORDER BY m.created_at`,
      [req.tenant.id, conv.id],
    )).rows;
    const orders = (await db.query(
      `SELECT id, folio, total, status, online_status, created_at FROM orders
        WHERE restaurant_id = $1 AND source = 'web'
          AND right(regexp_replace(coalesce(customer_phone, ''), '\\D', '', 'g'), 10) = right($2, 10)
        ORDER BY created_at DESC LIMIT 5`,
      [req.tenant.id, conv.wa_id],
    )).rows;
    return { conversation: view({ ...conv, unread: 0 }), messages, orders };
  });
  res.json(data);
}));

// Contestar como persona: la conversacion queda con el personal hasta devolverla al bot.
router.post('/conversations/:id/messages', staff, ah(async (req, res) => {
  const text = str(req.body?.text, { field: 'text', required: true, max: 4000 });
  const rid = req.tenant.id;
  const { conv, settings } = await withTenant(rid, async (db) => {
    const c = await loadConversation(db, rid, req.params.id);
    const s = await loadSettings(db, rid);
    if (!s?.access_token_enc || !s.phone_number_id) throw badRequest('Primero conecta el número de WhatsApp', 'WHATSAPP_NOT_CONFIGURED');
    if (!view(c).window_open) {
      throw new HttpError(409, 'Pasaron más de 24 horas desde el último mensaje del cliente; WhatsApp no deja escribirle hasta que vuelva a escribir.', 'WINDOW_CLOSED');
    }
    return { conv: c, settings: s };
  });
  const message = M.text(text);
  const result = await transmit(settings, conv.wa_id, message);
  const saved = await withTenant(rid, async (db) => {
    const row = await logOutbound(db, conv, message, result, { sender: 'personal', userId: req.user.id });
    await db.query(
      `UPDATE whatsapp_conversations SET mode = 'humano', needs_attention = false, unread = 0
        WHERE id = $1 AND restaurant_id = $2`,
      [conv.id, rid],
    );
    return row;
  });
  if (!result.ok) throw new HttpError(502, `WhatsApp no aceptó el mensaje: ${result.error}`, 'WHATSAPP_SEND_FAILED');
  res.status(201).json({ message: { ...saved, sent_by_name: req.user.name ?? null } });
}));

router.post('/conversations/:id/take', staff, ah(async (req, res) => {
  const conv = await withTenant(req.tenant.id, async (db) => {
    const c = await loadConversation(db, req.tenant.id, req.params.id, { lock: true });
    return (await db.query(
      `UPDATE whatsapp_conversations SET mode = 'humano', needs_attention = false WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
      [c.id, req.tenant.id],
    )).rows[0];
  });
  res.json({ conversation: view(conv) });
}));

// Devolver al bot: el cliente vuelve al menu en su siguiente mensaje.
router.post('/conversations/:id/release', staff, ah(async (req, res) => {
  const conv = await withTenant(req.tenant.id, async (db) => {
    const c = await loadConversation(db, req.tenant.id, req.params.id, { lock: true });
    return (await db.query(
      `UPDATE whatsapp_conversations SET mode = 'bot', needs_attention = false, state = 'inicio'
        WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
      [c.id, req.tenant.id],
    )).rows[0];
  });
  res.json({ conversation: view(conv) });
}));

// Quitar el aviso sin contestar (p. ej. ya se resolvio por telefono).
router.post('/conversations/:id/seen', staff, ah(async (req, res) => {
  const conv = await withTenant(req.tenant.id, async (db) => {
    const c = await loadConversation(db, req.tenant.id, req.params.id, { lock: true });
    return (await db.query(
      'UPDATE whatsapp_conversations SET needs_attention = false, unread = 0 WHERE id = $1 AND restaurant_id = $2 RETURNING *',
      [c.id, req.tenant.id],
    )).rows[0];
  });
  res.json({ conversation: view(conv) });
}));

export default router;
