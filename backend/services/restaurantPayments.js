// Pagos en linea de los pedidos del portal con la cuenta de Clip de CADA
// restaurante (Fase 3).
//
// - Credenciales cifradas en restaurant_payment_settings (secrets.js). La API
//   solo dice si estan configuradas; nunca las regresa.
// - "Pagar en linea con Clip": el pedido se crea con online_payment_status =
//   'pendiente' (no llega al POS), se crea la liga con las credenciales del
//   restaurante y el cliente va a Clip. Al confirmarse el pago (webhook,
//   reconciliador o la pagina de resultado) se registra un order_payment con
//   el metodo "Clip en linea" (sin turno de caja) y el pedido sigue el flujo
//   normal: aceptar -> cocina -> entregar. Sin pago en N minutos se cancela.
import { withPlatform, withTenant } from '../config/database.js';
import { HttpError, badRequest } from '../utils/http.js';
import { createClipClient, hasCheckoutCredentials } from './clip/client.js';
import { reconcileLocalCheckout } from './clip/reconcile.js';
import { notify } from './notifier.js';
import { acceptOnlineOrder, getOnlineSettings } from './online.js';
import { decryptSecret, encryptSecret, secretsAvailable } from './secrets.js';
import { restaurantSiteUrl, restaurantWebhookUrl } from './urls.js';

const FIELDS = {
  clip_api_key: 'clip_api_key_enc',
  clip_secret_key: 'clip_secret_key_enc',
  clip_webhook_secret: 'clip_webhook_secret_enc',
};
// El AAD amarra cada valor a su restaurante y a su campo.
const aad = (restaurantId, field) => `${restaurantId}:${field}`;

export async function getPaymentSettings(db, restaurantId) {
  await db.query('INSERT INTO restaurant_payment_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [restaurantId]);
  return (await db.query('SELECT * FROM restaurant_payment_settings WHERE restaurant_id = $1', [restaurantId])).rows[0];
}

/** Lo unico que sale por la API: si hay credenciales, nunca su valor. */
export function publicPaymentSettings(row, restaurant) {
  const configured = Boolean(row.clip_api_key_enc && row.clip_secret_key_enc);
  return {
    clip: {
      configured,
      webhook_secret_configured: Boolean(row.clip_webhook_secret_enc),
      webhook_url: restaurant ? restaurantWebhookUrl(restaurant) : null,
    },
    online_payment_enabled: row.online_payment_enabled,
    payment_timeout_minutes: row.payment_timeout_minutes,
    secrets_key_configured: secretsAvailable(),
    available: onlinePaymentAvailable(row),
    updated_at: row.updated_at,
  };
}

export const onlinePaymentAvailable = (row) => Boolean(
  row?.online_payment_enabled && row.clip_api_key_enc && row.clip_secret_key_enc && secretsAvailable(),
);

const SECRET_RE = /^[\x21-\x7e]{8,300}$/;

/**
 * Actualiza la configuracion. body: { clip_api_key, clip_secret_key,
 * clip_webhook_secret, remove_clip, online_payment_enabled, payment_timeout_minutes }.
 * Cadena vacia o ausente = no cambiar; remove_clip = borrar las credenciales.
 */
export async function updatePaymentSettings(db, restaurantId, body = {}) {
  const current = await getPaymentSettings(db, restaurantId);
  const set = {};
  if (body.remove_clip === true) {
    Object.assign(set, { clip_api_key_enc: null, clip_secret_key_enc: null, clip_webhook_secret_enc: null, online_payment_enabled: false });
  } else {
    for (const [field, column] of Object.entries(FIELDS)) {
      const v = body[field];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !SECRET_RE.test(v.trim())) {
        throw badRequest(`El valor de "${field}" no parece valido (sin espacios, 8 a 300 caracteres)`, 'INVALID_FIELD');
      }
      set[column] = encryptSecret(v.trim(), aad(restaurantId, field));
    }
    const hasKey = Boolean(set.clip_api_key_enc ?? current.clip_api_key_enc);
    const hasSecret = Boolean(set.clip_secret_key_enc ?? current.clip_secret_key_enc);
    if (hasKey !== hasSecret) {
      throw badRequest('Captura la API key y la clave secreta de Clip juntas', 'CLIP_CREDENTIALS_INCOMPLETE');
    }
  }
  if (body.online_payment_enabled !== undefined) {
    if (typeof body.online_payment_enabled !== 'boolean') throw badRequest('online_payment_enabled debe ser verdadero o falso', 'INVALID_FIELD');
    set.online_payment_enabled = body.remove_clip === true ? false : body.online_payment_enabled;
  }
  if (body.payment_timeout_minutes !== undefined) {
    const n = Number(body.payment_timeout_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw badRequest('El tiempo para pagar debe ser de 5 a 1440 minutos', 'INVALID_FIELD');
    set.payment_timeout_minutes = n;
  }
  const entries = Object.entries(set);
  if (!entries.length) throw badRequest('No hay cambios', 'NO_CHANGES');
  const next = { ...current, ...set };
  if (next.online_payment_enabled && !(next.clip_api_key_enc && next.clip_secret_key_enc)) {
    throw badRequest('Configura tus credenciales de Clip antes de activar el pago en linea', 'CLIP_NOT_CONFIGURED');
  }
  await db.query(
    `UPDATE restaurant_payment_settings SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
      WHERE restaurant_id = $1`,
    [restaurantId, ...entries.map(([, v]) => v)],
  );
  return getPaymentSettings(db, restaurantId);
}

/** Credenciales descifradas del restaurante (solo para hablar con Clip). */
export function decryptClipCredentials(row) {
  if (!row?.clip_api_key_enc) return { apiKey: '', secretKey: '', webhookSecret: '' };
  const rid = row.restaurant_id;
  return {
    apiKey: decryptSecret(row.clip_api_key_enc, aad(rid, 'clip_api_key')),
    secretKey: decryptSecret(row.clip_secret_key_enc, aad(rid, 'clip_secret_key')),
    webhookSecret: row.clip_webhook_secret_enc ? decryptSecret(row.clip_webhook_secret_enc, aad(rid, 'clip_webhook_secret')) : '',
  };
}

export async function loadRestaurantClipCredentials(restaurantId) {
  const row = await withTenant(restaurantId, (db) => getPaymentSettings(db, restaurantId));
  return decryptClipCredentials(row);
}

// ---------------------------------------------------------------------------
// Ligas de pago de pedidos
// ---------------------------------------------------------------------------

/**
 * Crea la liga de pago de un pedido (dentro de la transaccion del pedido; ver
 * la DECISION en subscriptions.ensureInvoiceCheckout). order: fila de orders.
 */
export async function createOrderCheckout(db, tenant, order, creds) {
  if (!hasCheckoutCredentials(creds)) {
    throw new HttpError(409, 'Este restaurante no tiene configurado el pago en linea', 'ONLINE_PAYMENT_UNAVAILABLE');
  }
  const back = `${restaurantSiteUrl(tenant)}/pago/resultado?pedido=${encodeURIComponent(order.public_token)}`;
  const link = await createClipClient(creds).createCheckout({
    amount: Number(order.total),
    description: `${tenant.name} - pedido #${order.folio}`,
    redirect: { success: `${back}&r=ok`, error: `${back}&r=error`, default: `${back}&r=cancelado` },
    webhookUrl: restaurantWebhookUrl(tenant),
    metadata: { tipo: 'pedido', order_id: order.id, restaurant_id: tenant.id, folio: String(order.folio) },
  });
  const row = (await db.query(
    `INSERT INTO clip_checkouts (restaurant_id, purpose, order_id, checkout_id, payment_url, amount, currency,
                                 expires_at, response_data)
     VALUES ($1, 'pedido', $2, $3, $4, $5, 'MXN', $6, $7) RETURNING *`,
    [tenant.id, order.id, link.checkout_id, link.payment_url, order.total, link.expires_at, JSON.stringify(link.raw)],
  )).rows[0];
  return { action: 'redirect', url: row.payment_url, checkout_id: row.id };
}

/** Liga vigente del pedido o una nueva (boton "Pagar" del seguimiento). */
export async function ensureOrderCheckout(tenant, orderToken, { now = new Date() } = {}) {
  const creds = await loadRestaurantClipCredentials(tenant.id);
  return withTenant(tenant.id, async (db) => {
    const o = (await db.query(
      `SELECT * FROM orders WHERE public_token = $1 AND restaurant_id = $2 AND source = 'web' FOR UPDATE`,
      [orderToken, tenant.id],
    )).rows[0];
    if (!o || o.online_payment_status === null) throw new HttpError(404, 'Pedido no encontrado', 'ORDER_NOT_FOUND');
    if (o.online_payment_status === 'pagado') throw new HttpError(409, 'El pedido ya esta pagado', 'ORDER_PAID');
    if (o.online_payment_status !== 'pendiente' || o.status === 'cancelada'
      || (o.payment_due_at && new Date(o.payment_due_at) <= now)) {
      throw new HttpError(409, 'El tiempo para pagar este pedido termino. Haz un pedido nuevo.', 'PAYMENT_WINDOW_CLOSED');
    }
    const current = (await db.query(
      `SELECT * FROM clip_checkouts WHERE order_id = $1 AND restaurant_id = $2 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [o.id, tenant.id],
    )).rows[0];
    if (current && (!current.expires_at || new Date(current.expires_at) > now)) {
      return { action: 'redirect', url: current.payment_url };
    }
    if (current) await db.query("UPDATE clip_checkouts SET status = 'expired', updated_at = now() WHERE id = $1", [current.id]);
    return createOrderCheckout(db, tenant, o, creds);
  });
}

/** Metodo "Clip en linea" del restaurante (se siembra si falta). */
async function onlineMethodId(db, restaurantId) {
  const found = (await db.query(
    `SELECT id FROM payment_methods WHERE restaurant_id = $1 AND kind = 'en_linea' ORDER BY active DESC, created_at LIMIT 1`,
    [restaurantId],
  )).rows[0];
  if (found) return found.id;
  await db.query('SELECT seed_pos_defaults($1)', [restaurantId]);
  return (await db.query(
    `SELECT id FROM payment_methods WHERE restaurant_id = $1 AND kind = 'en_linea' LIMIT 1`,
    [restaurantId],
  )).rows[0].id;
}

/**
 * Lo que reconcile.js aplica cuando Clip confirma el pago de un pedido (db de
 * withTenant del restaurante del checkout). Idempotente.
 */
export async function applyOrderCheckout(db, checkout, data) {
  const rid = checkout.restaurant_id;
  const o = (await db.query('SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [checkout.order_id, rid])).rows[0];
  if (!o) return { late: true };
  if (o.online_payment_status === 'pagado') return { late: true };
  if (o.status === 'cancelada') {
    // Se pago despues de cancelarse (por tiempo o por el cliente): hay que
    // reembolsar desde el panel de Clip del restaurante.
    return {
      late: true,
      after: async () => {
        const r = (await withPlatform((p) => p.query('SELECT name, contact_email FROM restaurants WHERE id = $1', [rid]))).rows[0];
        await notify('pago_tardio', { to: r?.contact_email, restaurant: r?.name, folio: o.folio, amount: checkout.amount });
      },
    };
  }
  const reference = String(data?.transaction_id || data?.receipt_no || checkout.checkout_id).slice(0, 100);
  await db.query(
    `INSERT INTO order_payments (restaurant_id, order_id, payment_method_id, cash_session_id, amount, tip,
                                 received, change_given, reference, created_by, clip_checkout_id)
     VALUES ($1, $2, $3, NULL, $4, 0, $4, 0, $5, NULL, $6)`,
    [rid, o.id, await onlineMethodId(db, rid), checkout.amount, reference, checkout.id],
  );
  await db.query(
    `UPDATE orders SET paid_amount = paid_amount + $3, online_payment_status = 'pagado', updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [o.id, rid, checkout.amount],
  );
  const settings = await getOnlineSettings(db, rid);
  if (settings.auto_accept && o.online_status === 'pendiente') {
    await acceptOnlineOrder(db, rid, o.id, { prepMinutes: settings.prep_time_minutes });
  }
  const email = o.customer_id
    ? (await db.query('SELECT email FROM customers WHERE id = $1 AND restaurant_id = $2', [o.customer_id, rid])).rows[0]?.email
    : null;
  const timezone = (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [o.branch_id, rid])).rows[0]?.timezone;
  // Ya pagado: confirmacion al cliente y aviso al restaurante (despues del commit).
  return {
    late: false,
    after: async () => {
      const [{ findRestaurantById }, emails] = await Promise.all([import('../middleware/tenant.js'), import('./emails.js')]);
      const tenant = await findRestaurantById(rid);
      if (!tenant) return;
      if (email) await emails.sendOrderReceived(tenant, { ...o, timezone }, email);
      await emails.alertNewOnlineOrder(tenant, o);
    },
  };
}

/** Concilia con Clip las ligas pendientes de un pedido (pagina de resultado). */
export async function reconcileOrder(restaurantId, orderId) {
  const pending = await withTenant(restaurantId, async (db) => (await db.query(
    `SELECT * FROM clip_checkouts WHERE restaurant_id = $1 AND order_id = $2 AND status = 'pending'`,
    [restaurantId, orderId],
  )).rows);
  for (const c of pending) await reconcileLocalCheckout(c);
}

/**
 * Job: cancela los pedidos que no se pagaron a tiempo. Antes de cancelar
 * concilia con Clip (el pago pudo llegar sin webhook).
 */
export async function expireUnpaidOrders({ now = new Date() } = {}) {
  const due = await withPlatform(async (db) => (await db.query(
    `SELECT restaurant_id, id FROM orders
      WHERE online_payment_status = 'pendiente' AND status <> 'cancelada' AND payment_due_at <= $1
      ORDER BY payment_due_at LIMIT 200`,
    [now],
  )).rows);
  const cancelled = [];
  for (const { restaurant_id: rid, id } of due) {
    try {
      await reconcileOrder(rid, id);
    } catch (err) {
      console.error(`[pagos] no se pudo conciliar el pedido ${id}:`, err.message);
    }
    const done = await withTenant(rid, async (db) => {
      const o = (await db.query('SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, rid])).rows[0];
      if (!o || o.online_payment_status !== 'pendiente' || o.status === 'cancelada') return false;
      await db.query(
        `UPDATE orders SET status = 'cancelada', online_payment_status = 'cancelado', cancelled_at = now(),
                cancel_reason = 'No se completó el pago en línea a tiempo', updated_at = now()
          WHERE id = $1 AND restaurant_id = $2`,
        [id, rid],
      );
      await db.query(
        `UPDATE clip_checkouts SET status = 'expired', updated_at = now()
          WHERE order_id = $1 AND restaurant_id = $2 AND status = 'pending'`,
        [id, rid],
      );
      return true;
    });
    if (done) cancelled.push(id);
  }
  return { cancelled };
}
