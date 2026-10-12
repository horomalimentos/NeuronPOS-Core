// Ventas por evento (modulo "eventos"): el gerente arma el evento y sus
// productos; cualquier persona del personal levanta pedidos (vendedor), cobra
// y entrega. Produccion por producto y control de vendedores (efectivo y comision).
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { createEventOrder, loadEventOrders, readCustomer, readEventItems, soldByProduct } from '../services/events.js';
import { can, hasCapability } from '../services/permissions.js';
import { HttpError, SLUG_RE, ah, badRequest, buildSet, forbidden, money, notFound, oneOf, requireUuid, str } from '../utils/http.js';
import { int, requireBranch } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('eventos'));

const STATUSES = ['borrador', 'abierto', 'cerrado', 'terminado'];
const EVENT_COLS = `e.id, e.branch_id, b.name AS branch_name, e.name, e.slug, e.place, e.description,
  to_char(e.sale_date, 'YYYY-MM-DD') AS sale_date, e.order_deadline, e.status, e.commission_pct, e.created_at`;
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'evento';

function eventFields(body, creating) {
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 120 }),
    place: str(body.place, { field: 'place', max: 200 }),
    description: str(body.description, { field: 'description', max: 2000 }),
    sale_date: body.sale_date === undefined ? undefined : String(body.sale_date),
    order_deadline: body.order_deadline === undefined ? undefined : (body.order_deadline ? new Date(body.order_deadline) : null),
    status: oneOf(body.status, STATUSES, 'status'),
    commission_pct: body.commission_pct === undefined ? undefined : Number(body.commission_pct),
    slug: body.slug === undefined ? undefined : String(body.slug).trim().toLowerCase(),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  if (f.sale_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(f.sale_date)) throw badRequest('La fecha debe ser AAAA-MM-DD', 'INVALID_FIELD');
  if (creating && !f.sale_date) throw badRequest('Indica la fecha del evento', 'MISSING_FIELD');
  if (f.order_deadline && Number.isNaN(f.order_deadline.getTime())) throw badRequest('Fecha limite invalida', 'INVALID_FIELD');
  if (f.commission_pct !== undefined && (!Number.isFinite(f.commission_pct) || f.commission_pct < 0 || f.commission_pct > 100)) {
    throw badRequest('La comision debe ser de 0 a 100 %', 'INVALID_FIELD');
  }
  if (f.slug !== undefined && !SLUG_RE.test(f.slug)) throw badRequest('La direccion solo lleva letras, numeros y guiones', 'INVALID_FIELD');
  return f;
}

async function eventOr404(db, req, id, { lock = false } = {}) {
  requireUuid(id);
  const e = (await db.query(`SELECT ${EVENT_COLS} FROM events e JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
    WHERE e.id = $1 AND e.restaurant_id = $2 ${lock ? 'FOR UPDATE OF e' : ''}`, [id, req.tenant.id])).rows[0];
  if (!e) throw notFound('Evento no encontrado', 'EVENT_NOT_FOUND');
  return e;
}

async function productsOf(db, rid, eventId) {
  const sold = await soldByProduct(db, rid, eventId);
  return (await db.query(
    'SELECT id, name, description, price, image_url, max_quantity, sort_order, active FROM event_products WHERE restaurant_id = $1 AND event_id = $2 ORDER BY sort_order, name',
    [rid, eventId],
  )).rows.map((p) => ({ ...p, sold: sold.get(p.id) || 0, left: p.max_quantity == null ? null : Math.max(0, p.max_quantity - (sold.get(p.id) || 0)) }));
}

router.get('/', can('orders'), ah(async (req, res) => {
  const events = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${EVENT_COLS},
            (SELECT count(*)::int FROM event_orders o WHERE o.event_id = e.id AND o.status <> 'cancelado') AS orders,
            (SELECT coalesce(sum(o.total), 0) FROM event_orders o WHERE o.event_id = e.id AND o.status <> 'cancelado') AS total
       FROM events e JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
      WHERE e.restaurant_id = $1 ORDER BY e.sale_date DESC, e.created_at DESC LIMIT 200`,
    [req.tenant.id],
  )).rows);
  res.json({ events });
}));

router.post('/', can('manage'), ah(async (req, res) => {
  const body = req.body || {};
  const f = eventFields(body, true);
  const branchId = requireBranch(req, body.branch_id);
  const event = await withTenant(req.tenant.id, async (db) => {
    let slug = f.slug || slugify(`${f.name}-${f.sale_date.slice(5)}`);
    for (let i = 2; (await db.query('SELECT 1 FROM events WHERE restaurant_id = $1 AND slug = $2', [req.tenant.id, slug])).rowCount; i += 1) {
      if (f.slug) throw new HttpError(409, 'Ya hay un evento con esa direccion', 'SLUG_TAKEN');
      slug = `${slugify(f.name).slice(0, 50)}-${i}`;
    }
    const { rows } = await db.query(
      `INSERT INTO events (restaurant_id, branch_id, name, slug, place, description, sale_date, order_deadline, status, commission_pct, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'borrador'), coalesce($10, 0), $11) RETURNING id`,
      [req.tenant.id, branchId, f.name, slug, f.place || null, f.description || null, f.sale_date, f.order_deadline ?? null, f.status ?? null, f.commission_pct ?? null, req.user.id],
    );
    return eventOr404(db, req, rows[0].id);
  });
  res.status(201).json({ event });
}));

router.get('/:id', can('orders'), ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const event = await eventOr404(db, req, req.params.id);
    return { event, products: await productsOf(db, req.tenant.id, event.id) };
  });
  res.json(data);
}));

router.patch('/:id', can('manage'), ah(async (req, res) => {
  const f = eventFields(req.body || {}, false);
  const set = buildSet(f, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const event = await withTenant(req.tenant.id, async (db) => {
    await eventOr404(db, req, req.params.id);
    try {
      await db.query(`UPDATE events SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`, [req.params.id, req.tenant.id, ...set.values]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'Ya hay un evento con esa direccion', 'SLUG_TAKEN');
      throw err;
    }
    return eventOr404(db, req, req.params.id);
  });
  res.json({ event });
}));

router.delete('/:id', can('manage'), ah(async (req, res) => {
  await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    const has = await db.query('SELECT 1 FROM event_orders WHERE event_id = $1 AND restaurant_id = $2 LIMIT 1', [e.id, req.tenant.id]);
    if (has.rowCount) throw new HttpError(409, 'El evento ya tiene pedidos: marcalo como terminado', 'EVENT_HAS_ORDERS');
    await db.query('DELETE FROM events WHERE id = $1 AND restaurant_id = $2', [e.id, req.tenant.id]);
  });
  res.status(204).end();
}));

// Reemplaza los productos: [{ id?, name, description, price, image_url, max_quantity, active }].
router.put('/:id/products', can('manage'), ah(async (req, res) => {
  const list = req.body?.products;
  if (!Array.isArray(list) || list.length > 60) throw badRequest('products debe ser una lista', 'INVALID_FIELD');
  const rows = list.map((p, i) => {
    const price = money(p?.price, { field: 'price' });
    const max = p?.max_quantity === null || p?.max_quantity === '' || p?.max_quantity === undefined ? null : int(p.max_quantity, { field: 'max_quantity', min: 1, max: 100000 });
    const img = str(p?.image_url, { field: 'image_url', max: 500 }) || null;
    if (img && !/^https?:\/\//.test(img) && !img.startsWith('/api/uploads/files/')) throw badRequest('La imagen debe ser una URL', 'INVALID_URL');
    return {
      id: p?.id ? requireUuid(p.id, 'id') : null,
      name: str(p?.name, { field: 'name', required: true, max: 120 }),
      description: str(p?.description, { field: 'description', max: 500 }) || null,
      price, image_url: img, max_quantity: max, sort_order: i, active: p?.active !== false,
    };
  });
  const products = await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    const current = (await db.query('SELECT id FROM event_products WHERE restaurant_id = $1 AND event_id = $2', [req.tenant.id, e.id])).rows.map((r) => r.id);
    const sold = await soldByProduct(db, req.tenant.id, e.id);
    for (const p of rows) {
      if (p.max_quantity != null && p.id && p.max_quantity < (sold.get(p.id) || 0)) {
        throw badRequest(`"${p.name}" ya tiene ${sold.get(p.id)} vendidos: el cupo no puede ser menor`, 'INVALID_FIELD');
      }
      if (p.id && current.includes(p.id)) {
        await db.query(
          `UPDATE event_products SET name = $3, description = $4, price = $5, image_url = $6, max_quantity = $7, sort_order = $8, active = $9
            WHERE id = $1 AND restaurant_id = $2`,
          [p.id, req.tenant.id, p.name, p.description, p.price, p.image_url, p.max_quantity, p.sort_order, p.active],
        );
      } else {
        await db.query(
          `INSERT INTO event_products (restaurant_id, event_id, name, description, price, image_url, max_quantity, sort_order, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [req.tenant.id, e.id, p.name, p.description, p.price, p.image_url, p.max_quantity, p.sort_order, p.active],
        );
      }
    }
    // Los que ya no vienen: se borran (o se apagan si ya tienen pedidos).
    for (const id of current.filter((id) => !rows.some((p) => p.id === id))) {
      if (sold.has(id) || (await db.query('SELECT 1 FROM event_order_items WHERE product_id = $1 LIMIT 1', [id])).rowCount) {
        await db.query('UPDATE event_products SET active = false WHERE id = $1 AND restaurant_id = $2', [id, req.tenant.id]);
      } else {
        await db.query('DELETE FROM event_products WHERE id = $1 AND restaurant_id = $2', [id, req.tenant.id]);
      }
    }
    return productsOf(db, req.tenant.id, e.id);
  });
  res.json({ products });
}));

// --- Pedidos ---

router.get('/:id/orders', can('orders'), ah(async (req, res) => {
  const status = oneOf(req.query.status, ['pendiente', 'pagado', 'cancelado'], 'status');
  const orders = await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    // El vendedor (sin permiso de gerente) ve sus pedidos y los de la pagina.
    const mineOnly = !(await hasCapability(req, 'manage')) && req.query.all !== '1';
    return loadEventOrders(db, req.tenant.id,
      `o.event_id = $2 AND ($3::text IS NULL OR o.status = $3) AND (NOT $4 OR o.seller_id = $5 OR o.seller_id IS NULL)`,
      [e.id, status || null, mineOnly, req.user.id]);
  });
  res.json({ orders });
}));

router.post('/:id/orders', can('orders'), ah(async (req, res) => {
  const b = req.body || {};
  const items = readEventItems(b.items);
  const customer = readCustomer(b);
  const order = await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    if (!['abierto', 'cerrado'].includes(e.status)) throw badRequest('El evento no esta abierto para pedidos', 'EVENT_NOT_OPEN');
    const o = await createEventOrder(db, req.tenant.id, e.id, { ...customer, items, sellerId: req.user.id, paid: b.paid === true, userId: req.user.id });
    return (await loadEventOrders(db, req.tenant.id, 'o.id = $2', [o.id]))[0];
  });
  res.status(201).json({ order });
}));

async function orderAction(req, fn) {
  requireUuid(req.params.orderId);
  return withTenant(req.tenant.id, async (db) => {
    const o = (await db.query('SELECT * FROM event_orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [req.params.orderId, req.tenant.id])).rows[0];
    if (!o) throw notFound('Pedido no encontrado', 'EVENT_ORDER_NOT_FOUND');
    await fn(db, o);
    return (await loadEventOrders(db, req.tenant.id, 'o.id = $2', [o.id]))[0];
  });
}

router.post('/orders/:orderId/pay', can('orders'), ah(async (req, res) => {
  const order = await orderAction(req, async (db, o) => {
    if (o.status !== 'pendiente') throw badRequest(o.status === 'pagado' ? 'El pedido ya esta pagado' : 'El pedido esta cancelado', 'EVENT_ORDER_CLOSED');
    // Quien cobra se vuelve el vendedor si el pedido vino de la pagina.
    await db.query(`UPDATE event_orders SET status = 'pagado', paid_at = now(), paid_by = $3, seller_id = coalesce(seller_id, $3), updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`, [o.id, req.tenant.id, req.user.id]);
  });
  res.json({ order });
}));

router.post('/orders/:orderId/cancel', can('orders'), ah(async (req, res) => {
  const isManager = await hasCapability(req, 'manage');
  const order = await orderAction(req, async (db, o) => {
    if (o.status === 'cancelado') throw badRequest('El pedido ya esta cancelado', 'EVENT_ORDER_CLOSED');
    if (o.status === 'pagado' && !isManager) throw forbidden('Un pedido pagado solo lo cancela el gerente', 'ROLE_REQUIRED');
    if (o.seller_id && o.seller_id !== req.user.id && !isManager) throw forbidden('Es pedido de otro vendedor', 'ROLE_REQUIRED');
    await db.query("UPDATE event_orders SET status = 'cancelado', updated_at = now() WHERE id = $1 AND restaurant_id = $2", [o.id, req.tenant.id]);
  });
  res.json({ order });
}));

router.post('/orders/:orderId/deliver', can('orders'), ah(async (req, res) => {
  const order = await orderAction(req, async (db, o) => {
    if (o.status !== 'pagado') throw badRequest('Cobra el pedido antes de entregarlo', 'EVENT_ORDER_NOT_PAID');
    if (o.delivered_at) throw badRequest('El pedido ya se entrego', 'EVENT_ORDER_DELIVERED');
    await db.query('UPDATE event_orders SET delivered_at = now(), delivered_by = $3, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [o.id, req.tenant.id, req.user.id]);
  });
  res.json({ order });
}));

// Cuanto preparar de cada producto (pendientes + pagados) y cuanto ya se entrego.
router.get('/:id/production', can('orders'), ah(async (req, res) => {
  const production = await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    return (await db.query(
      `SELECT p.id AS product_id, p.name,
              coalesce(sum(i.quantity) FILTER (WHERE o.status = 'pendiente'), 0)::int AS pending,
              coalesce(sum(i.quantity) FILTER (WHERE o.status = 'pagado'), 0)::int AS paid,
              coalesce(sum(i.quantity) FILTER (WHERE o.status = 'pagado' AND o.delivered_at IS NOT NULL), 0)::int AS delivered
         FROM event_products p
         LEFT JOIN event_order_items i ON i.product_id = p.id AND i.restaurant_id = p.restaurant_id
         LEFT JOIN event_orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
        WHERE p.restaurant_id = $1 AND p.event_id = $2
        GROUP BY p.id, p.name, p.sort_order ORDER BY p.sort_order, p.name`,
      [req.tenant.id, e.id],
    )).rows;
  });
  res.json({ production });
}));

// Vendedores: lo cobrado, su comision y el efectivo que ya entregaron.
router.get('/:id/sellers', can('manage'), ah(async (req, res) => {
  const sellers = await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    return (await db.query(
      `SELECT u.id AS seller_id, u.name,
              count(*) FILTER (WHERE o.status = 'pagado')::int AS orders,
              coalesce(sum(o.total) FILTER (WHERE o.status = 'pagado'), 0) AS collected,
              round(coalesce(sum(o.total) FILTER (WHERE o.status = 'pagado'), 0) * $3 / 100, 2) AS commission,
              coalesce(s.cash_delivered, 0) AS cash_delivered, coalesce(s.commission_paid, false) AS commission_paid
         FROM event_orders o
         JOIN users u ON u.id = o.seller_id AND u.restaurant_id = o.restaurant_id
         LEFT JOIN event_seller_settlements s ON s.event_id = o.event_id AND s.seller_id = o.seller_id
        WHERE o.restaurant_id = $1 AND o.event_id = $2
        GROUP BY u.id, u.name, s.cash_delivered, s.commission_paid ORDER BY u.name`,
      [req.tenant.id, e.id, e.commission_pct],
    )).rows;
  });
  res.json({ sellers });
}));

router.put('/:id/sellers/:sellerId', can('manage'), ah(async (req, res) => {
  requireUuid(req.params.sellerId, 'seller_id');
  const b = req.body || {};
  const cash = b.cash_delivered === undefined ? null : money(b.cash_delivered, { field: 'cash_delivered' });
  const paid = b.commission_paid === undefined ? null : b.commission_paid === true;
  await withTenant(req.tenant.id, async (db) => {
    const e = await eventOr404(db, req, req.params.id);
    const u = await db.query('SELECT 1 FROM users WHERE id = $1 AND restaurant_id = $2', [req.params.sellerId, req.tenant.id]);
    if (!u.rowCount) throw notFound('Vendedor no encontrado', 'USER_NOT_FOUND');
    await db.query(
      `INSERT INTO event_seller_settlements (restaurant_id, event_id, seller_id, cash_delivered, commission_paid, updated_by)
       VALUES ($1, $2, $3, coalesce($4, 0), coalesce($5, false), $6)
       ON CONFLICT (event_id, seller_id) DO UPDATE SET
         cash_delivered = coalesce($4, event_seller_settlements.cash_delivered),
         commission_paid = coalesce($5, event_seller_settlements.commission_paid), updated_by = $6, updated_at = now()`,
      [req.tenant.id, e.id, req.params.sellerId, cash, paid, req.user.id],
    );
  });
  res.json({ ok: true });
}));

export default router;
