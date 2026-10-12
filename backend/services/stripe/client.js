// Cliente HTTP de Stripe (Checkout Sessions) sin SDK, con la misma forma que
// el de Clip (services/clip/client.js) para poder usar cualquiera de los dos.
//
//   POST /v1/checkout/sessions        crea la liga de pago (id, url)
//   GET  /v1/checkout/sessions/{id}   estado autoritativo (server-to-server)
//
// Autenticacion: Bearer con la llave secreta (sk_live_... / sk_test_...).
// Stripe recibe form-urlencoded y responde JSON. El webhook se firma aparte
// con el signing secret (whsec_...), ver verifyStripeSignature.
//
// El transporte HTTP es intercambiable (setStripeTransport): las pruebas
// instalan un Stripe simulado y nunca se llama a la API real.
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { HttpError } from '../../utils/http.js';

export class StripeError extends HttpError {
  constructor(message, code = 'STRIPE_ERROR', status = 502) {
    super(status, message, code);
  }
}

/** Aplana un objeto a la notacion de Stripe: a[b][0][c]=v. */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function fetchTransport({ method, url, headers, body, timeoutMs }) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : formEncode(body).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

let transport = fetchTransport;

/**
 * Cambia el transporte HTTP. fn({ method, url, headers, body, timeoutMs })
 * -> { status, data }. Sin argumento regresa al fetch real.
 */
export function setStripeTransport(fn) {
  transport = fn || fetchTransport;
}

async function send(req) {
  // Red de seguridad: las pruebas jamas deben pegarle a la API real de Stripe.
  if (env.isTest && transport === fetchTransport) {
    throw new StripeError('Stripe real deshabilitado en pruebas: instala un transporte simulado', 'STRIPE_DISABLED_IN_TESTS');
  }
  try {
    return await transport(req);
  } catch (err) {
    if (err instanceof StripeError) throw err;
    throw new StripeError(`No se pudo conectar con Stripe: ${err.message}`, 'STRIPE_UNREACHABLE');
  }
}

/** Credenciales de la cuenta de Stripe de la plataforma (variables de entorno). */
export const platformStripeCredentials = () => ({
  secretKey: env.stripeSecretKey,
  webhookSecret: env.stripeWebhookSecret,
});

export const hasStripeCredentials = (c) => Boolean(c?.secretKey);

// Stripe permite que una sesion expire entre 30 minutos y 24 horas.
const MIN_TTL_MS = 30 * 60000;
const MAX_TTL_MS = 24 * 3600000;

export function createStripeClient({ secretKey } = {}) {
  if (!secretKey) {
    throw new StripeError('Las credenciales de Stripe no estan configuradas', 'STRIPE_NOT_CONFIGURED', 409);
  }
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  return {
    /**
     * Crea una liga de pago. amount en pesos (MXN). redirect: { success, cancel };
     * Stripe reemplaza {CHECKOUT_SESSION_ID} en success. ttlMs entre 30 min y 24 h.
     * Regresa { checkout_id, payment_url, expires_at, raw }.
     */
    async createCheckout({ amount, description, redirect, metadata, customerEmail, ttlMs = MAX_TTL_MS }) {
      const cents = Math.round(Number(amount) * 100);
      if (!Number.isInteger(cents) || cents <= 0) throw new StripeError('Monto invalido para Stripe', 'STRIPE_BAD_AMOUNT', 400);
      const ttl = Math.min(Math.max(ttlMs, MIN_TTL_MS), MAX_TTL_MS);
      const { status, data } = await send({
        method: 'POST',
        url: `${env.stripeApiUrl}/v1/checkout/sessions`,
        headers,
        timeoutMs: 30000,
        body: {
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [{
            quantity: 1,
            price_data: { currency: 'mxn', unit_amount: cents, product_data: { name: description } },
          }],
          success_url: redirect?.success,
          cancel_url: redirect?.cancel,
          customer_email: customerEmail || undefined,
          expires_at: Math.floor((Date.now() + ttl) / 1000),
          metadata,
          payment_intent_data: { metadata },
        },
      });
      if (status < 200 || status >= 300) {
        const msg = data?.error?.message || `Stripe respondio ${status}`;
        throw new StripeError(`Stripe no pudo crear la liga de pago: ${msg}`, status === 401 || status === 403 ? 'STRIPE_AUTH_FAILED' : 'STRIPE_ERROR');
      }
      if (!data?.id || !data?.url) throw new StripeError('Stripe no regreso la liga de pago', 'STRIPE_BAD_RESPONSE');
      return {
        checkout_id: String(data.id),
        payment_url: String(data.url),
        expires_at: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
        raw: data,
      };
    },

    /** Estado autoritativo de una sesion; null si Stripe no responde o no la encuentra. */
    async getCheckout(checkoutId) {
      try {
        const { status, data } = await send({
          method: 'GET',
          url: `${env.stripeApiUrl}/v1/checkout/sessions/${encodeURIComponent(checkoutId)}`,
          headers,
          timeoutMs: 15000,
        });
        if (status < 200 || status >= 300) {
          console.error(`[Stripe] GET checkout ${checkoutId} respondio ${status}`);
          return null;
        }
        return data;
      } catch (err) {
        console.error(`[Stripe] GET checkout ${checkoutId} fallo:`, err.message);
        return null;
      }
    },
  };
}

/**
 * Estado normalizado de una Checkout Session, con los mismos valores que usa
 * Clip (clip/status.js): 'completed' | 'pending' | 'expired'.
 */
export function normalizeStripeStatus(session) {
  if (!session) return 'pending';
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'completed';
  if (session.status === 'expired') return 'expired';
  return 'pending';
}

/**
 * Valida el header Stripe-Signature ("t=...,v1=...,v1=...") sobre el cuerpo
 * crudo: HMAC-SHA256 de "t.cuerpo" con el signing secret. Rechaza firmas mas
 * viejas que toleranceSec para evitar repeticiones.
 */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!rawBody || !header || !secret) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return crypto.timingSafeEqual(Buffer.from(s, 'hex'), expected);
  });
}
