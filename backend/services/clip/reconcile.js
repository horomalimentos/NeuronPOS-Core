// Conciliacion de ligas de pago con Clip (adaptado de
// services/clipReconciler.js del NeuronPOS original).
//
// Ni el webhook ni la pagina de resultado confian en lo que les llega: solo
// disparan esta funcion, que pregunta a Clip server-to-server
// (GET /v2/checkout/{id}) con las credenciales DUENAS del checkout:
//   - suscripcion -> cuenta de Clip de la plataforma
//   - pedido y recarga (monedero) -> cuenta de Clip del restaurante del checkout
// Valida id, monto y moneda, normaliza el estado y, si esta pagado, aplica el
// pago una sola vez (applied_at, con la fila bloqueada).
//
// Alcance (scope): el webhook de la plataforma solo busca checkouts de
// suscripcion; el de un restaurante solo busca, con RLS de ese restaurante,
// checkouts de sus pedidos. Un webhook de A nunca toca nada de B.
import { withPlatform, withTenant } from '../../config/database.js';
import { createClipClient, hasCheckoutCredentials, platformClipCredentials } from './client.js';
import { checkoutMismatch, normalizeClipStatus, rawStatusOf } from './status.js';

// Importes diferidos: subscriptions.js y restaurantPayments.js tambien usan
// este modulo.
const appliers = {
  suscripcion: async () => (await import('../subscriptions.js')).applyInvoiceCheckout,
  pedido: async () => (await import('../restaurantPayments.js')).applyOrderCheckout,
  recarga: async () => (await import('../wallet.js')).applyTopupCheckout,
};

const runIn = (checkout) => (checkout.purpose === 'suscripcion'
  ? (fn) => withPlatform(fn)
  : (fn) => withTenant(checkout.restaurant_id, fn));

async function credentialsFor(checkout) {
  if (checkout.purpose === 'suscripcion') return platformClipCredentials();
  const { loadRestaurantClipCredentials } = await import('../restaurantPayments.js');
  return loadRestaurantClipCredentials(checkout.restaurant_id);
}

/** Busca un checkout por el id de Clip dentro del alcance del webhook. */
export async function findCheckout(scope, checkoutId) {
  if (!checkoutId) return null;
  if (scope.kind === 'platform') {
    return withPlatform(async (db) => (await db.query(
      `SELECT * FROM clip_checkouts WHERE checkout_id = $1 AND purpose = 'suscripcion'`,
      [checkoutId],
    )).rows[0] || null);
  }
  return withTenant(scope.restaurantId, async (db) => (await db.query(
    `SELECT * FROM clip_checkouts WHERE checkout_id = $1 AND restaurant_id = $2 AND purpose IN ('pedido', 'recarga')`,
    [checkoutId, scope.restaurantId],
  )).rows[0] || null);
}

/**
 * Concilia un checkout local (fila de clip_checkouts). Regresa
 * { status, applied, late, mismatch? }.
 */
export async function reconcileLocalCheckout(local, { now = new Date() } = {}) {
  let creds;
  try {
    creds = await credentialsFor(local);
  } catch (err) {
    console.error(`[ClipReconciler] credenciales ilegibles para ${local.checkout_id}:`, err.message);
    return { status: local.status, applied: false };
  }
  if (!hasCheckoutCredentials(creds)) return { status: local.status, applied: false };

  const data = await createClipClient(creds).getCheckout(local.checkout_id);
  const run = runIn(local);
  if (!data) {
    await run((db) => db.query('UPDATE clip_checkouts SET last_checked_at = now() WHERE id = $1', [local.id]));
    return { status: local.status, applied: false };
  }
  const mismatch = checkoutMismatch(local, data);
  if (mismatch) {
    console.error(`[ClipReconciler] ${local.checkout_id}: la respuesta de Clip no coincide (${mismatch})`);
    return { status: local.status, applied: false, mismatch };
  }
  const status = normalizeClipStatus(rawStatusOf(data), data);
  const apply = status === 'completed' ? await appliers[local.purpose]() : null;

  const result = await run(async (db) => {
    const row = (await db.query('SELECT * FROM clip_checkouts WHERE id = $1 FOR UPDATE', [local.id])).rows[0];
    if (!row) return { status, applied: false };
    // Un pago confirmado no regresa a otro estado; una liga que expiro
    // localmente si puede pasar a completed (se pago despues).
    const next = row.status === 'completed' ? 'completed' : status;
    const ref = data.transaction_id || data.receipt_no || null;
    await db.query(
      `UPDATE clip_checkouts SET status = $2, response_data = $3, last_checked_at = now(),
              clip_reference = coalesce($4, clip_reference), updated_at = now()
        WHERE id = $1`,
      [row.id, next, JSON.stringify(data), ref ? String(ref).slice(0, 200) : null],
    );
    if (next !== 'completed' || row.applied_at) return { status: next, applied: false };
    const outcome = await apply(db, row, data, now);
    await db.query(
      'UPDATE clip_checkouts SET applied_at = now(), late_payment = $2 WHERE id = $1',
      [row.id, Boolean(outcome.late)],
    );
    return { status: next, applied: !outcome.late, late: Boolean(outcome.late), after: outcome.after };
  });
  if (result.after) {
    try { await result.after(); } catch (err) { console.error('[ClipReconciler] aviso fallo:', err.message); }
  }
  const { after, ...rest } = result;
  return rest;
}

/** Webhook: concilia por id de Clip dentro del alcance. */
export async function reconcileCheckoutId(scope, checkoutId, opts) {
  const local = await findCheckout(scope, checkoutId);
  if (!local) return { matched: false };
  return { matched: true, ...(await reconcileLocalCheckout(local, opts)) };
}

/** Job: concilia las ligas pendientes recientes (por si no llego el webhook). */
export async function reconcilePendingCheckouts({ now = new Date(), limit = 100 } = {}) {
  const pending = await withPlatform(async (db) => (await db.query(
    `SELECT * FROM clip_checkouts
      WHERE status = 'pending' AND created_at > $1::timestamptz - interval '7 days'
      ORDER BY last_checked_at NULLS FIRST, created_at LIMIT $2`,
    [now, limit],
  )).rows);
  const results = [];
  for (const c of pending) {
    try {
      results.push({ id: c.id, ...(await reconcileLocalCheckout(c, { now })) });
    } catch (err) {
      console.error(`[ClipReconciler] ${c.checkout_id}:`, err.message);
    }
  }
  return results;
}
