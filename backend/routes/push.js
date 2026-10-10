// Notificaciones push (modulo 'push'): llave publica VAPID y suscripciones
// del navegador. Personal y repartidores con su sesion; clientes con su
// sesion (todos sus pedidos) o como invitados con el token del seguimiento
// (solo ese pedido). Los avisos se mandan en services/push.js.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, optionalCustomer } from '../middleware/auth.js';
import { publicLimiter } from '../middleware/rateLimits.js';
import { requireModule } from '../middleware/requireModule.js';
import { requireTenant } from '../middleware/tenant.js';
import { deleteSubscription, getVapidKeys, saveSubscription } from '../services/push.js';
import { HttpError, ah, badRequest, notFound } from '../utils/http.js';

const router = Router();
router.use(requireTenant, publicLimiter, requireModule('push'));

const invalid = () => badRequest('Suscripción inválida', 'INVALID_SUBSCRIPTION');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

router.get('/key', ah(async (req, res) => {
  const keys = await getVapidKeys();
  if (!keys) throw new HttpError(503, 'Las notificaciones no están configuradas en el servidor', 'PUSH_NOT_CONFIGURED');
  res.json({ public_key: keys.publicKey });
}));

// Personal y repartidores.
router.post('/subscribe', authenticateUser, ah(async (req, res) => {
  const ok = await withTenant(req.tenant.id, (db) =>
    saveSubscription(db, req.tenant.id, (req.body || {}).subscription, { user_id: req.user.id }));
  if (!ok) throw invalid();
  res.json({ ok: true });
}));

router.post('/unsubscribe', authenticateUser, ah(async (req, res) => {
  await withTenant(req.tenant.id, (db) =>
    deleteSubscription(db, req.tenant.id, (req.body || {}).endpoint, { user_id: req.user.id }));
  res.json({ ok: true });
}));

/**
 * Clientes del sitio. Con token del seguimiento: si el pedido es del cliente
 * con sesion se suscribe su cuenta; si no, solo ese pedido.
 */
async function customerOwner(db, req) {
  const { token } = req.body || {};
  if (token === undefined || token === null || token === '') {
    if (!req.customer) throw badRequest('Inicia sesión o abre el seguimiento de tu pedido', 'MISSING_FIELD');
    return { customer_id: req.customer.id };
  }
  if (!TOKEN_RE.test(String(token))) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  const o = (await db.query(
    "SELECT id, customer_id FROM orders WHERE public_token = $1 AND restaurant_id = $2 AND source = 'web'",
    [String(token), req.tenant.id],
  )).rows[0];
  if (!o) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  if (o.customer_id && req.customer?.id === o.customer_id) return { customer_id: o.customer_id };
  return { order_id: o.id };
}

router.post('/customer/subscribe', optionalCustomer, ah(async (req, res) => {
  const ok = await withTenant(req.tenant.id, async (db) =>
    saveSubscription(db, req.tenant.id, (req.body || {}).subscription, await customerOwner(db, req)));
  if (!ok) throw invalid();
  res.json({ ok: true });
}));

router.post('/customer/unsubscribe', optionalCustomer, ah(async (req, res) => {
  await withTenant(req.tenant.id, async (db) =>
    deleteSubscription(db, req.tenant.id, (req.body || {}).endpoint, await customerOwner(db, req)));
  res.json({ ok: true });
}));

export default router;
