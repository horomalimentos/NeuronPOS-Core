// Webhooks de Clip.
//
//   POST /api/webhooks/clip/plataforma     cobros de suscripcion y de NeuronPOS Delivery (cuenta de la plataforma)
//   POST /api/webhooks/clip/r/:restaurante pagos de pedidos (cuenta del restaurante; id o slug)
//
// Como en el NeuronPOS original, el cuerpo del webhook NO se cree: solo
// dispara la conciliacion server-to-server con Clip (services/clip/reconcile.js).
// Ademas, si hay webhook secret configurado (CLIP_WEBHOOK_SECRET o el del
// restaurante), la firma HMAC-SHA256 del header x-clip-signature es
// obligatoria y una firma invalida se rechaza con 401.
//
// Cada webhook queda en clip_webhook_events (con RLS: el de un restaurante
// solo lo ve ese restaurante; el de la plataforma, solo la plataforma).
import { Router } from 'express';
import pool, { withPlatform, withTenant } from '../config/database.js';
import { platformClipCredentials } from '../services/clip/client.js';
import { reconcileCheckoutId } from '../services/clip/reconcile.js';
import { verifyClipSignature, webhookCheckoutId, webhookEventType } from '../services/clip/status.js';
import { reconcileMarketplaceCheckoutId } from '../services/marketplaceMoney.js';
import { loadRestaurantClipCredentials } from '../services/restaurantPayments.js';
import { HttpError, SLUG_RE, UUID_RE, ah, notFound } from '../utils/http.js';

const router = Router();

async function logEvent(scope, entry) {
  const run = scope.kind === 'platform' ? (fn) => withPlatform(fn) : (fn) => withTenant(scope.restaurantId, fn);
  try {
    await run((db) => db.query(
      `INSERT INTO clip_webhook_events (restaurant_id, checkout_id, event_type, signature_valid, matched, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [scope.kind === 'platform' ? null : scope.restaurantId, entry.checkoutId, entry.eventType,
        entry.signatureValid, entry.matched, JSON.stringify(entry.payload ?? null)],
    ));
  } catch (err) {
    console.error('[Clip webhook] no se pudo registrar el evento:', err.message);
  }
}

async function handle(req, res, scope, webhookSecret) {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const checkoutId = webhookCheckoutId(payload);
  const eventType = webhookEventType(payload);
  let signatureValid = null;
  if (webhookSecret) {
    signatureValid = verifyClipSignature(req.rawBody, req.headers['x-clip-signature'], webhookSecret);
    if (!signatureValid) {
      await logEvent(scope, { checkoutId, eventType, signatureValid, matched: false, payload });
      throw new HttpError(401, 'Firma del webhook invalida', 'INVALID_SIGNATURE');
    }
  }
  let matched = false;
  try {
    let r = checkoutId ? await reconcileCheckoutId(scope, checkoutId) : { matched: false };
    // La cuenta de la plataforma tambien cobra NeuronPOS Delivery (pedidos con tarjeta y adeudos).
    if (!r.matched && checkoutId && scope.kind === 'platform') r = await reconcileMarketplaceCheckoutId(checkoutId);
    matched = r.matched;
  } catch (err) {
    // No es fatal para Clip: el reconciliador periodico lo vuelve a intentar.
    console.error('[Clip webhook] la conciliacion fallo:', err.message);
  }
  await logEvent(scope, { checkoutId, eventType, signatureValid, matched, payload });
  res.json({ received: true });
}

router.post(['/clip/plataforma', '/clip/platform'], ah(async (req, res) => {
  await handle(req, res, { kind: 'platform' }, platformClipCredentials().webhookSecret);
}));

router.post('/clip/r/:ref', ah(async (req, res) => {
  const ref = String(req.params.ref || '').toLowerCase();
  let restaurant = null;
  if (UUID_RE.test(ref)) restaurant = (await pool.query('SELECT id, slug FROM restaurants WHERE id = $1', [ref])).rows[0];
  else if (SLUG_RE.test(ref)) restaurant = (await pool.query('SELECT id, slug FROM restaurants WHERE slug = $1', [ref])).rows[0];
  if (!restaurant) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
  let secret = '';
  try {
    secret = (await loadRestaurantClipCredentials(restaurant.id)).webhookSecret;
  } catch (err) {
    console.error('[Clip webhook] no se pudieron leer las credenciales:', err.message);
    throw new HttpError(503, 'Credenciales de pago no disponibles', 'SECRETS_UNAVAILABLE');
  }
  await handle(req, res, { kind: 'restaurant', restaurantId: restaurant.id }, secret);
}));

export default router;
