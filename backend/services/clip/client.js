// Cliente HTTP de Clip (Checkout Redireccionado, /v2/checkout).
//
// Mismas llamadas que el NeuronPOS original (routes/clipPayments.js y
// services/clipReconciler.js), pero sin credenciales fijas: cada cliente se
// crea con las de la plataforma (suscripciones) o con las de un restaurante
// (pedidos en linea).
//
//   POST /v2/checkout        crea la liga de pago (payment_request_id, payment_request_url)
//   GET  /v2/checkout/{id}   estado autoritativo (server-to-server)
//
// Autenticacion: Basic base64(API_KEY:SECRET_KEY). El webhook secret es
// aparte y solo valida firmas (ver status.js).
//
// El transporte HTTP es intercambiable (setClipTransport): las pruebas
// instalan un Clip simulado y nunca se llama a la API real.
import { env } from '../../config/env.js';
import { HttpError } from '../../utils/http.js';

export class ClipError extends HttpError {
  constructor(message, code = 'CLIP_ERROR', status = 502) {
    super(status, message, code);
  }
}

async function fetchTransport({ method, url, headers, body, timeoutMs }) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
export function setClipTransport(fn) {
  transport = fn || fetchTransport;
}

async function send(req) {
  // Red de seguridad: las pruebas jamas deben pegarle a la API real de Clip.
  if (env.isTest && transport === fetchTransport) {
    throw new ClipError('Clip real deshabilitado en pruebas: instala un transporte simulado', 'CLIP_DISABLED_IN_TESTS');
  }
  try {
    return await transport(req);
  } catch (err) {
    if (err instanceof ClipError) throw err;
    throw new ClipError(`No se pudo conectar con Clip: ${err.message}`, 'CLIP_UNREACHABLE');
  }
}

/** Credenciales de la cuenta de Clip de la plataforma (variables de entorno). */
export const platformClipCredentials = () => ({
  apiKey: env.clipApiKey,
  secretKey: env.clipSecretKey,
  webhookSecret: env.clipWebhookSecret,
});

export const hasCheckoutCredentials = (c) => Boolean(c?.apiKey && c?.secretKey);

export function createClipClient({ apiKey, secretKey } = {}) {
  if (!apiKey || !secretKey) {
    throw new ClipError('Las credenciales de Clip no estan configuradas', 'CLIP_NOT_CONFIGURED', 409);
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  return {
    /**
     * Crea una liga de pago. payload: { amount, description, redirect: {success,error,default},
     * webhookUrl, metadata }. Regresa { checkout_id, payment_url, expires_at, raw }.
     */
    async createCheckout({ amount, description, redirect, webhookUrl, metadata }) {
      const { status, data } = await send({
        method: 'POST',
        url: `${env.clipApiUrl}/v2/checkout`,
        headers,
        timeoutMs: 30000,
        body: {
          amount: Number(amount),
          currency: 'MXN',
          purchase_description: description,
          redirection_url: redirect,
          webhook_url: webhookUrl,
          custom_payment_options: { payment_method_types: ['debit', 'credit'] },
          metadata,
        },
      });
      if (status < 200 || status >= 300) {
        const msg = data?.message || data?.error || `Clip respondio ${status}`;
        throw new ClipError(`Clip no pudo crear la liga de pago: ${msg}`, status === 401 || status === 403 ? 'CLIP_AUTH_FAILED' : 'CLIP_ERROR');
      }
      const checkoutId = data?.payment_request_id || data?.id || data?.checkout_id;
      const url = data?.payment_request_url || data?.payment_link || data?.url;
      if (!checkoutId || !url) throw new ClipError('Clip no regreso la liga de pago', 'CLIP_BAD_RESPONSE');
      const expires = data.expires_at ? new Date(data.expires_at) : new Date(Date.now() + 3 * 86400000);
      return {
        checkout_id: String(checkoutId),
        payment_url: String(url),
        expires_at: Number.isNaN(expires.getTime()) ? null : expires.toISOString(),
        raw: data,
      };
    },

    /** Estado autoritativo de un checkout; null si Clip no responde o no lo encuentra. */
    async getCheckout(checkoutId) {
      try {
        const { status, data } = await send({
          method: 'GET',
          url: `${env.clipApiUrl}/v2/checkout/${encodeURIComponent(checkoutId)}`,
          headers,
          timeoutMs: 15000,
        });
        if (status < 200 || status >= 300) {
          console.error(`[Clip] GET /v2/checkout/${checkoutId} respondio ${status}`);
          return null;
        }
        return data;
      } catch (err) {
        console.error(`[Clip] GET /v2/checkout/${checkoutId} fallo:`, err.message);
        return null;
      }
    },
  };
}
