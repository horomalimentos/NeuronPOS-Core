// Cobros con la cuenta de la PLATAFORMA (mensualidades y Nayo) con Stripe o
// con Clip, con una sola forma para quien cobra.
//
// - Proveedor de las ligas nuevas: Stripe si STRIPE_SECRET_KEY esta
//   configurada; si no, Clip (CLIP_API_KEY / CLIP_SECRET_KEY).
// - Cada liga guarda su proveedor (columna provider): una liga de Clip creada
//   antes de cambiar a Stripe se sigue conciliando con Clip.
// - Ni el webhook ni la pagina de resultado se creen: solo disparan la
//   consulta server-to-server (fetchPlatformCheckout).
import { createClipClient, hasCheckoutCredentials, platformClipCredentials } from './clip/client.js';
import { checkoutMismatch, normalizeClipStatus, rawStatusOf } from './clip/status.js';
import {
  createStripeClient, hasStripeCredentials, normalizeStripeStatus, platformStripeCredentials,
} from './stripe/client.js';
import { platformWebhookUrl } from './urls.js';

/** 'stripe' | 'clip' | null (sin cuenta configurada). */
export function platformProvider() {
  if (hasStripeCredentials(platformStripeCredentials())) return 'stripe';
  if (hasCheckoutCredentials(platformClipCredentials())) return 'clip';
  return null;
}

export const platformPaymentsAvailable = () => platformProvider() !== null;

/**
 * Crea una liga de pago con el proveedor vigente. back es la URL de regreso;
 * se le agrega pago=ok|error|cancelado. ttlMs solo aplica a Stripe (30 min a 24 h).
 * Regresa { provider, checkout_id, payment_url, expires_at, raw }.
 */
export async function createPlatformCheckout({ amount, description, back, metadata, ttlMs }) {
  const provider = platformProvider();
  const sep = back.includes('?') ? '&' : '?';
  const url = (estado) => `${back}${sep}pago=${estado}`;
  if (provider === 'stripe') {
    const link = await createStripeClient(platformStripeCredentials()).createCheckout({
      amount, description, metadata, ttlMs, redirect: { success: url('ok'), cancel: url('cancelado') },
    });
    return { provider, ...link };
  }
  // Sin Stripe: Clip (createClipClient avisa si tampoco esta configurado).
  const link = await createClipClient(platformClipCredentials()).createCheckout({
    amount,
    description,
    redirect: { success: url('ok'), error: url('error'), default: url('cancelado') },
    webhookUrl: platformWebhookUrl(),
    metadata,
  });
  return { provider: 'clip', ...link };
}

/** Referencia del pago en el proveedor (Clip: transaccion; Stripe: payment_intent). */
export function paymentReference(data) {
  const pi = data?.payment_intent;
  return data?.transaction_id || data?.receipt_no || (typeof pi === 'string' ? pi : pi?.id) || null;
}

/** Diferencia entre la liga local y la sesion de Stripe, o null. */
export function stripeMismatch(local, s) {
  if (s?.id && String(s.id) !== String(local.checkout_id)) return 'id';
  if (s?.amount_total !== undefined && s?.amount_total !== null
    && Math.abs(Number(s.amount_total) - Math.round(Number(local.amount) * 100)) > 1) return 'amount';
  if (s?.currency && local.currency && String(s.currency).toUpperCase() !== String(local.currency).toUpperCase()) return 'currency';
  return null;
}

/**
 * Consulta server-to-server una liga local (fila con provider, checkout_id,
 * amount, currency). Regresa undefined sin credenciales, null si el
 * proveedor no responde, o { status, data, reference, mismatch }.
 */
export async function fetchPlatformCheckout(local) {
  if (local.provider === 'stripe') {
    const creds = platformStripeCredentials();
    if (!hasStripeCredentials(creds)) return undefined;
    const data = await createStripeClient(creds).getCheckout(local.checkout_id);
    if (!data) return null;
    return {
      data,
      mismatch: stripeMismatch(local, data),
      status: normalizeStripeStatus(data),
      reference: paymentReference(data),
    };
  }
  const creds = platformClipCredentials();
  if (!hasCheckoutCredentials(creds)) return undefined;
  const data = await createClipClient(creds).getCheckout(local.checkout_id);
  if (!data) return null;
  return {
    data,
    mismatch: checkoutMismatch(local, data),
    status: normalizeClipStatus(rawStatusOf(data), data),
    reference: paymentReference(data),
  };
}
