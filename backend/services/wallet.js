// Monedero del cliente (modulo 'monedero'), como el de Horom. Todo cambio de
// saldo pasa por applyWallet, que bloquea al cliente, mueve el saldo y deja el
// renglon en wallet_transactions.
//
// - Recargas: liga de Clip del restaurante (clip_checkouts.purpose =
//   'recarga'); reconcile.js llama a applyTopupCheckout cuando Clip confirma.
// - Pagos en caja: un pago "Monedero" (kind 'monedero') autorizado con el
//   codigo de 6 digitos del cliente (el mismo de la lealtad).
// - Pagos en linea: el cliente ya inicio sesion; se cobra al crear el pedido.
// - Pedido en linea rechazado: el dinero regresa al monedero.
import { withTenant } from '../config/database.js';
import { HttpError, badRequest } from '../utils/http.js';
import { createClipClient, hasCheckoutCredentials } from './clip/client.js';
import { verifyCustomerCode } from './loyalty.js';
import { toCents } from './posMath.js';
import { restaurantSiteUrl, restaurantWebhookUrl } from './urls.js';

export const DEFAULT_WALLET_SETTINGS = {
  topups_enabled: true,
  min_topup: 50,
  max_topup: 5000,
  suggested_amounts: [100, 200, 500],
  max_balance: 20000,
  web_enabled: true,
  require_code: true,
};

const COLS = 'topups_enabled, min_topup, max_topup, suggested_amounts, max_balance, web_enabled, require_code';

export async function loadWalletSettings(db, restaurantId) {
  const row = (await db.query(`SELECT ${COLS} FROM wallet_settings WHERE restaurant_id = $1`, [restaurantId])).rows[0];
  const s = { ...DEFAULT_WALLET_SETTINGS, ...(row || {}) };
  for (const k of ['min_topup', 'max_topup', 'max_balance']) s[k] = Number(s[k]);
  s.suggested_amounts = (s.suggested_amounts || []).map(Number);
  return s;
}

/** Ajustes del monedero si el restaurante tiene el modulo vigente; si no, null. */
export async function activeWallet(db, restaurantId) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM restaurant_modules
      WHERE restaurant_id = $1 AND module_code = 'monedero' AND enabled AND (ends_at IS NULL OR ends_at > now())`,
    [restaurantId],
  );
  return rowCount ? loadWalletSettings(db, restaurantId) : null;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Suma (o resta) saldo al cliente y lo registra. Regresa el saldo nuevo. */
export async function applyWallet(db, restaurantId, {
  customerId, kind, amount, orderId = null, paymentId = null, checkoutId = null, reason = null, userId = null,
  maxBalance = null,
}) {
  const cents = toCents(amount);
  if (!cents) return null;
  const c = (await db.query(
    'SELECT wallet_balance FROM customers WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
    [customerId, restaurantId],
  )).rows[0];
  if (!c) throw badRequest('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
  const balance = toCents(c.wallet_balance) + cents;
  if (balance < 0) {
    throw badRequest(`El cliente solo tiene $${Number(c.wallet_balance).toFixed(2)} en su monedero`, 'INSUFFICIENT_BALANCE');
  }
  if (maxBalance !== null && cents > 0 && balance > toCents(maxBalance)) {
    throw badRequest(`El saldo máximo del monedero es $${Number(maxBalance).toFixed(2)}`, 'ABOVE_MAX_BALANCE');
  }
  const value = cents / 100;
  await db.query(
    `UPDATE customers SET wallet_balance = $3,
            wallet_loaded = wallet_loaded + CASE WHEN $4 = 'topup' THEN $5::numeric ELSE 0 END,
            wallet_spent = wallet_spent + CASE WHEN $4 = 'purchase' THEN -$5::numeric WHEN $4 = 'refund' THEN -$5::numeric ELSE 0 END,
            updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [customerId, restaurantId, balance / 100, kind, value],
  );
  await db.query(
    `INSERT INTO wallet_transactions (restaurant_id, customer_id, kind, amount, balance_after, order_id, payment_id,
                                     checkout_id, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [restaurantId, customerId, kind, value, balance / 100, orderId, paymentId, checkoutId, reason, userId],
  );
  return balance / 100;
}

/** Metodo de pago "Monedero" del restaurante (se crea la primera vez). */
export async function walletMethodId(db, restaurantId) {
  const found = (await db.query(
    "SELECT id FROM payment_methods WHERE restaurant_id = $1 AND kind = 'monedero' ORDER BY active DESC, created_at LIMIT 1",
    [restaurantId],
  )).rows[0];
  if (found) return found.id;
  for (const name of ['Monedero', 'Monedero del cliente']) {
    const { rows } = await db.query(
      `INSERT INTO payment_methods (restaurant_id, name, kind, sort_order) VALUES ($1, $2, 'monedero', 81)
       ON CONFLICT (restaurant_id, name) DO NOTHING RETURNING id`,
      [restaurantId, name],
    );
    if (rows[0]) return rows[0].id;
  }
  return (await db.query(
    "INSERT INTO payment_methods (restaurant_id, name, kind, sort_order) VALUES ($1, $2, 'monedero', 81) RETURNING id",
    [restaurantId, `Monedero ${Date.now()}`],
  )).rows[0].id;
}

// ---------------------------------------------------------------------------
// Cobro en caja
// ---------------------------------------------------------------------------

/**
 * Prepara un pago con monedero en caja: valida modulo, cliente y saldo.
 * Regresa { methodId, amount, customerId, requireCode }; el codigo y el cargo
 * se hacen en commitWalletPayment, ya con el pago insertado.
 */
export async function prepareWalletPayment(db, restaurantId, order, wallet) {
  const s = await activeWallet(db, restaurantId);
  if (!s) throw new HttpError(402, 'El módulo de monedero no está contratado', 'MODULE_NOT_ENABLED');
  const customerId = String(wallet?.customer_id || order.customer_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw badRequest('Indica el cliente que paga con su monedero', 'MISSING_FIELD');
  if (order.customer_id && order.customer_id !== customerId) throw badRequest('La orden es de otro cliente', 'CUSTOMER_MISMATCH');
  const amount = round2(wallet?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Indica cuánto se paga con el monedero', 'INVALID_FIELD');
  const c = (await db.query('SELECT wallet_balance, active FROM customers WHERE id = $1 AND restaurant_id = $2', [customerId, restaurantId])).rows[0];
  if (!c || !c.active) throw badRequest('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
  if (toCents(amount) > toCents(c.wallet_balance)) {
    throw badRequest(`El cliente solo tiene $${Number(c.wallet_balance).toFixed(2)} en su monedero`, 'INSUFFICIENT_BALANCE');
  }
  return { methodId: await walletMethodId(db, restaurantId), amount, customerId, requireCode: s.require_code };
}

/**
 * Verifica el codigo (una vez por cliente y cobro: verified es un Set
 * compartido con el canje de puntos), liga el cliente a la orden y cobra.
 */
export async function commitWalletPayment(db, restaurantId, order, prep, { paymentId, code, userId, verified }) {
  if (prep.requireCode && !verified?.has(prep.customerId)) {
    await verifyCustomerCode(db, restaurantId, prep.customerId, code);
    verified?.add(prep.customerId);
  }
  await attachCustomer(db, restaurantId, order, prep.customerId);
  await db.query('UPDATE order_payments SET wallet_customer_id = $3 WHERE id = $1 AND restaurant_id = $2',
    [paymentId, restaurantId, prep.customerId]);
  await applyWallet(db, restaurantId, {
    customerId: prep.customerId, kind: 'purchase', amount: -prep.amount, orderId: order.id, paymentId,
    reason: `Orden #${order.folio}`, userId,
  });
}

export async function attachCustomer(db, restaurantId, order, customerId) {
  if (order.customer_id) return;
  await db.query(
    `UPDATE orders o SET customer_id = c.id, customer_name = coalesce(o.customer_name, c.name),
            customer_phone = coalesce(o.customer_phone, c.phone)
       FROM customers c WHERE o.id = $1 AND o.restaurant_id = $2 AND c.id = $3 AND c.restaurant_id = $2`,
    [order.id, restaurantId, customerId],
  );
  order.customer_id = customerId;
}

// ---------------------------------------------------------------------------
// Pedidos en linea
// ---------------------------------------------------------------------------

/**
 * Cobra todo el pedido en linea con el monedero del cliente (dentro de la
 * transaccion que lo crea). order: fila con total ya calculado.
 */
export async function payWebOrderWithWallet(db, restaurantId, order, customerId) {
  const s = await activeWallet(db, restaurantId);
  if (!s || !s.web_enabled) throw badRequest('El pago con monedero no está disponible', 'WALLET_UNAVAILABLE');
  const { rows: [pay] } = await db.query(
    `INSERT INTO order_payments (restaurant_id, order_id, payment_method_id, cash_session_id, amount, tip,
                                 received, change_given, reference, created_by, wallet_customer_id)
     VALUES ($1, $2, $3, NULL, $4, 0, $4, 0, 'Monedero', NULL, $5) RETURNING id`,
    [restaurantId, order.id, await walletMethodId(db, restaurantId), order.total, customerId],
  );
  await applyWallet(db, restaurantId, {
    customerId, kind: 'purchase', amount: -Number(order.total), orderId: order.id, paymentId: pay.id,
    reason: `Pedido en línea #${order.folio}`,
  });
  await db.query(
    `UPDATE orders SET paid_amount = paid_amount + $3, online_payment_status = 'pagado', updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [order.id, restaurantId, order.total],
  );
}

/** Regresa al monedero lo que se pago con el en un pedido (al rechazarlo). */
export async function refundOrderWallet(db, restaurantId, order, { reason, userId = null } = {}) {
  const pays = (await db.query(
    `SELECT p.id, p.amount, p.wallet_customer_id FROM order_payments p
      WHERE p.restaurant_id = $1 AND p.order_id = $2 AND p.wallet_customer_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.payment_id = p.id AND t.kind = 'refund')`,
    [restaurantId, order.id],
  )).rows;
  for (const p of pays) {
    await applyWallet(db, restaurantId, {
      customerId: p.wallet_customer_id, kind: 'refund', amount: Number(p.amount), orderId: order.id, paymentId: p.id,
      reason: reason || `Pedido #${order.folio} cancelado`, userId,
    });
  }
  return pays.reduce((s, p) => s + Number(p.amount), 0);
}

// ---------------------------------------------------------------------------
// Recargas con Clip
// ---------------------------------------------------------------------------

/** Valida el monto de una recarga contra los ajustes y el saldo maximo. */
export function checkTopupAmount(s, amount, balance) {
  const n = round2(amount);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('Escribe cuánto quieres recargar', 'INVALID_FIELD');
  if (n < s.min_topup) throw badRequest(`La recarga mínima es de $${s.min_topup.toFixed(2)}`, 'BELOW_MIN_TOPUP');
  if (n > s.max_topup) throw badRequest(`La recarga máxima es de $${s.max_topup.toFixed(2)}`, 'ABOVE_MAX_TOPUP');
  if (toCents(balance) + toCents(n) > toCents(s.max_balance)) {
    throw badRequest(`Con esta recarga pasarías el saldo máximo de $${s.max_balance.toFixed(2)}`, 'ABOVE_MAX_BALANCE');
  }
  return n;
}

/** Crea la liga de Clip de una recarga (cuenta del restaurante). */
export async function createTopupCheckout(db, tenant, customer, amount, creds) {
  if (!hasCheckoutCredentials(creds)) {
    throw new HttpError(409, 'Este restaurante no tiene configurado el pago en línea', 'ONLINE_PAYMENT_UNAVAILABLE');
  }
  const back = `${restaurantSiteUrl(tenant)}/cuenta?recarga=`;
  const link = await createClipClient(creds).createCheckout({
    amount,
    description: `${tenant.name} - recarga de monedero`,
    redirect: { success: `${back}ok`, error: `${back}error`, default: `${back}cancelada` },
    webhookUrl: restaurantWebhookUrl(tenant),
    metadata: { tipo: 'recarga', customer_id: customer.id, restaurant_id: tenant.id },
  });
  const row = (await db.query(
    `INSERT INTO clip_checkouts (restaurant_id, purpose, customer_id, checkout_id, payment_url, amount, currency,
                                 expires_at, response_data)
     VALUES ($1, 'recarga', $2, $3, $4, $5, 'MXN', $6, $7) RETURNING *`,
    [tenant.id, customer.id, link.checkout_id, link.payment_url, amount, link.expires_at, JSON.stringify(link.raw)],
  )).rows[0];
  return { id: row.id, url: row.payment_url };
}

/**
 * Lo que reconcile.js aplica cuando Clip confirma una recarga (db de
 * withTenant del restaurante). Idempotente: una recarga se acredita una vez
 * (indice unico por checkout). El monto ya lo comparo reconcile con Clip.
 */
export async function applyTopupCheckout(db, checkout) {
  const done = await db.query("SELECT 1 FROM wallet_transactions WHERE checkout_id = $1 AND kind = 'topup'", [checkout.id]);
  if (done.rowCount) return { late: true };
  // Sin tope de saldo: el dinero ya se cobro.
  await applyWallet(db, checkout.restaurant_id, {
    customerId: checkout.customer_id, kind: 'topup', amount: Number(checkout.amount), checkoutId: checkout.id,
    reason: 'Recarga con tarjeta',
  });
  return { late: false };
}

/** Concilia con Clip las recargas pendientes de un cliente (al volver de Clip). */
export async function reconcileCustomerTopups(restaurantId, customerId) {
  const { reconcileLocalCheckout } = await import('./clip/reconcile.js');
  const pending = await withTenant(restaurantId, async (db) => (await db.query(
    `SELECT * FROM clip_checkouts WHERE restaurant_id = $1 AND customer_id = $2 AND purpose = 'recarga'
        AND status = 'pending' AND created_at > now() - interval '7 days'`,
    [restaurantId, customerId],
  )).rows);
  for (const c of pending) {
    try {
      await reconcileLocalCheckout(c);
    } catch (err) {
      console.error(`[monedero] no se pudo conciliar la recarga ${c.id}:`, err.message);
    }
  }
}
