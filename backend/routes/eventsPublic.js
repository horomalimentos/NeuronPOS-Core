// Pagina publica de un evento (/evento/<slug>): productos con lo que queda y
// pedido del cliente (se paga al recoger). Modulo "eventos".
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { orderLimiter, publicLimiter } from '../middleware/rateLimits.js';
import { requireModule } from '../middleware/requireModule.js';
import { requireTenant } from '../middleware/tenant.js';
import { createEventOrder, loadEventOrders, readCustomer, readEventItems, soldByProduct } from '../services/events.js';
import { HttpError, SLUG_RE, ah, badRequest, notFound } from '../utils/http.js';

const router = Router();
router.use(requireTenant, publicLimiter, requireModule('eventos'));

async function publicEvent(db, rid, slug) {
  if (!SLUG_RE.test(String(slug))) throw notFound('Evento no encontrado', 'EVENT_NOT_FOUND');
  const e = (await db.query(
    `SELECT e.id, e.name, e.slug, e.place, e.description, to_char(e.sale_date, 'YYYY-MM-DD') AS sale_date, e.order_deadline, e.status,
            b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone
       FROM events e JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
      WHERE e.restaurant_id = $1 AND e.slug = $2 AND e.status <> 'borrador'`,
    [rid, String(slug)],
  )).rows[0];
  if (!e) throw notFound('Evento no encontrado', 'EVENT_NOT_FOUND');
  e.accepting = e.status === 'abierto' && (!e.order_deadline || new Date(e.order_deadline) > new Date());
  return e;
}

router.get('/:slug', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const event = await publicEvent(db, req.tenant.id, req.params.slug);
    const sold = await soldByProduct(db, req.tenant.id, event.id);
    const products = (await db.query(
      'SELECT id, name, description, price, image_url, max_quantity FROM event_products WHERE restaurant_id = $1 AND event_id = $2 AND active ORDER BY sort_order, name',
      [req.tenant.id, event.id],
    )).rows.map(({ max_quantity, ...p }) => ({ ...p, left: max_quantity == null ? null : Math.max(0, max_quantity - (sold.get(p.id) || 0)) }));
    const { id, ...pub } = event;
    return { event: pub, products };
  });
  res.json(data);
}));

router.post('/:slug/orders', orderLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const items = readEventItems(b.items);
  const customer = readCustomer(b);
  if (!customer.customer_phone || customer.customer_phone.replace(/\D/g, '').length < 7) throw badRequest('Escribe tu telefono', 'INVALID_PHONE');
  const order = await withTenant(req.tenant.id, async (db) => {
    const e = await publicEvent(db, req.tenant.id, req.params.slug);
    if (!e.accepting) throw new HttpError(409, 'Este evento ya no recibe pedidos', 'EVENT_CLOSED');
    const o = await createEventOrder(db, req.tenant.id, e.id, { ...customer, items });
    return (await loadEventOrders(db, req.tenant.id, 'o.id = $2', [o.id]))[0];
  });
  const { seller_id, seller_name, event_id, id, ...pub } = order;
  res.status(201).json({ order: pub });
}));

router.get('/:slug/orders/:token', ah(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(req.params.token)) throw notFound('Pedido no encontrado', 'EVENT_ORDER_NOT_FOUND');
  const order = await withTenant(req.tenant.id, async (db) => {
    const e = await publicEvent(db, req.tenant.id, req.params.slug);
    return (await loadEventOrders(db, req.tenant.id, 'o.event_id = $2 AND o.public_token = $3', [e.id, req.params.token]))[0];
  });
  if (!order) throw notFound('Pedido no encontrado', 'EVENT_ORDER_NOT_FOUND');
  const { seller_id, seller_name, event_id, id, ...pub } = order;
  res.json({ order: pub });
}));

export default router;
