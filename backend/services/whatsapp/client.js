// Cliente de la Cloud API de WhatsApp (Meta) por restaurante, adaptado de
// whatsappClient.js de Horom. Cada mensaje que sale se guarda en
// whatsapp_messages para el panel de conversaciones.
import { env } from '../../config/env.js';
import { decryptSecret, encryptSecret } from '../secrets.js';

export const tokenAad = (rid) => `whatsapp:${rid}:access_token`;
export const appSecretAad = (rid) => `whatsapp:${rid}:app_secret`;
export const encryptToken = (rid, v) => encryptSecret(v, tokenAad(rid));
export const encryptAppSecret = (rid, v) => encryptSecret(v, appSecretAad(rid));

/** Configuracion con el token descifrado (solo para mandar). */
export function credentials(settings) {
  return {
    phoneNumberId: settings.phone_number_id,
    accessToken: settings.access_token_enc ? decryptSecret(settings.access_token_enc, tokenAad(settings.restaurant_id)) : null,
  };
}

/** App secret con el que Meta firma los webhooks de este numero. */
export function appSecretFor(settings) {
  if (settings?.app_secret_enc) return decryptSecret(settings.app_secret_enc, appSecretAad(settings.restaurant_id));
  return env.whatsappAppSecret || null;
}

async function graphTransport({ phoneNumberId, accessToken }, payload) {
  const res = await fetch(`${env.whatsappGraphUrl}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}`, code: data?.error?.code };
  return { ok: true, id: data?.messages?.[0]?.id || null };
}

let transport = graphTransport;
/** Pruebas: reemplaza el envio real. fn(creds, payload) -> { ok, id?, error? } */
export function setWhatsAppTransport(fn) {
  transport = fn || graphTransport;
}

/** Texto que se guarda en el historial para cada tipo de mensaje. */
export function previewOf(message) {
  if (message.type === 'text') return message.text.body;
  if (message.type === 'interactive') {
    const i = message.interactive;
    const options = i.type === 'button'
      ? i.action.buttons.map((b) => b.reply.title)
      : i.type === 'list' ? i.action.sections.flatMap((s) => s.rows.map((r) => r.title)) : [];
    const extra = i.type === 'cta_url' ? i.action.parameters.url : options.length ? `[${options.join(' | ')}]` : '';
    return [i.body?.text, extra].filter(Boolean).join('\n');
  }
  return `[${message.type}]`;
}

/** Manda un mensaje (sin tocar la BD). Nunca lanza: { ok, id?, error? } */
export async function transmit(settings, waId, message) {
  const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId, ...message };
  try {
    const result = await transport(credentials(settings), payload);
    if (!result.ok) console.error('[whatsapp] No se pudo enviar:', result.error);
    return result;
  } catch (err) {
    console.error('[whatsapp] No se pudo enviar:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Guarda en el historial un mensaje que ya se mando (o que fallo). */
export async function logOutbound(db, conversation, message, result, { sender = 'bot', userId = null } = {}) {
  const preview = previewOf(message);
  const row = (await db.query(
    `INSERT INTO whatsapp_messages (restaurant_id, conversation_id, direction, sender, type, body, payload,
                                    wa_message_id, status, error, sent_by)
     VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [conversation.restaurant_id, conversation.id, sender, message.type, preview.slice(0, 4000), message,
      result.id || null, result.ok ? 'enviado' : 'fallido', result.ok ? null : String(result.error).slice(0, 500), userId],
  )).rows[0];
  await db.query(
    `UPDATE whatsapp_conversations SET last_message_at = now(), last_message_preview = $3
      WHERE id = $1 AND restaurant_id = $2`,
    [conversation.id, conversation.restaurant_id, preview.slice(0, 200)],
  );
  return row;
}
