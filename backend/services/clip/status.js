// Normalizacion de estados de Clip y verificacion de webhooks.
//
// normalizeClipStatus es la misma tabla del NeuronPOS original
// (services/clipStatusNormalizer.js): junta los estados del webhook y de
// GET /v2/checkout en: pending, completed, cancelled, expired, failed.
import crypto from 'node:crypto';

const WEBHOOK_MAP = {
  CREATED: 'pending',
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAID: 'completed',
  FAILED: 'failed',
  REFUNDED: 'failed',
};

const CHECKOUT_MAP = {
  CHECKOUT_CREATED: 'pending',
  CHECKOUT_PENDING: 'pending',
  CHECKOUT_COMPLETED: 'completed',
  CHECKOUT_CANCELLED: 'cancelled',
  CHECKOUT_EXPIRED: 'expired',
};

export function normalizeClipStatus(rawStatus, payload = {}) {
  if (!rawStatus) {
    if (payload?.status === 'PAID' || payload?.resource_status === 'COMPLETED') return 'completed';
    return 'pending';
  }
  const upper = String(rawStatus).toUpperCase().trim();
  if (CHECKOUT_MAP[upper]) return CHECKOUT_MAP[upper];
  if (WEBHOOK_MAP[upper]) return WEBHOOK_MAP[upper];
  if (upper.includes('COMPLETED') || upper.includes('PAID')) return 'completed';
  if (upper.includes('CANCEL')) return 'cancelled';
  if (upper.includes('EXPIR')) return 'expired';
  if (upper.includes('FAIL') || upper.includes('DECLIN') || upper.includes('REFUND')) return 'failed';
  return 'pending';
}

/** Estado crudo de una respuesta de GET /v2/checkout. */
export const rawStatusOf = (data) => data?.status || data?.resource_status || data?.payment_status;

/** El id del checkout que trae un webhook (Clip usa varias formas). */
export function webhookCheckoutId(payload = {}) {
  const id = payload.payment_request_id || payload.checkout_id || payload.data?.checkout_id
    || payload.data?.payment_request_id || payload.transaction_id || payload.id || null;
  return id === null || id === undefined ? null : String(id).slice(0, 200);
}

export function webhookEventType(payload = {}) {
  const t = payload.type || payload.event_type || payload.event
    || (payload.status ? `payment.${String(payload.status).toLowerCase()}` : null);
  return t ? String(t).slice(0, 100) : null;
}

/**
 * Firma del webhook: HMAC-SHA256 del cuerpo crudo con el webhook secret, en
 * el header x-clip-signature (hex o base64, con o sin prefijo "sha256=").
 * Comparacion en tiempo constante.
 */
export function verifyClipSignature(rawBody, header, secret) {
  if (!secret || !header || !rawBody) return false;
  const given = String(header).trim().replace(/^sha256=/i, '');
  const mac = crypto.createHmac('sha256', secret).update(rawBody).digest();
  for (const expected of [mac.toString('hex'), mac.toString('base64')]) {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Firma un cuerpo (para pruebas y para documentar el formato). */
export const signClipBody = (rawBody, secret) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

/**
 * Valida que la respuesta de Clip corresponda al checkout local (id, monto y
 * moneda), como el reconciliador original. Regresa null si todo cuadra o el
 * motivo del rechazo.
 */
export function checkoutMismatch(local, data) {
  const responseId = data?.payment_request_id || data?.id || data?.checkout_id;
  if (responseId && String(responseId) !== String(local.checkout_id)) return 'id';
  if (data?.amount !== undefined && data?.amount !== null) {
    const a = Math.round(Number(data.amount) * 100);
    const b = Math.round(Number(local.amount) * 100);
    if (Number.isFinite(a) && Math.abs(a - b) > 1) return 'amount';
  }
  if (data?.currency && local.currency && String(data.currency).toUpperCase() !== String(local.currency).toUpperCase()) {
    return 'currency';
  }
  return null;
}
