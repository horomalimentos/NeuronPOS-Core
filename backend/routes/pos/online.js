// Pedidos en linea dentro del POS: lista por sucursal, aceptar (va a
// cocina), rechazar con motivo (el cliente lo ve en el seguimiento) y marcar
// "en camino" los de domicilio. Despues se cobran con el flujo normal de
// pagos (POST /api/pos/orders/:id/payments) y al quedar pagados el cliente
// los ve como entregados.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { sendOrderRejected } from '../../services/emails.js';
import { deductOrder } from '../../services/inventory.js';
import { earnForOrder } from '../../services/loyalty.js';
import { redeemOrderVoucher } from '../../services/vouchers.js';
import { acceptOnlineOrder, getOnlineSettings } from '../../services/online.js';
import { toCents } from '../../services/posMath.js';
import { refundOrderWallet } from '../../services/wallet.js';
import { HttpError, ah, badRequest, oneOf, str } from '../../utils/http.js';
import { ROLES, int, requireBranch } from './common.js';
import { assertActive, loadItems, loadOrder, lockOrder } from './orders.js';
import { can } from '../../services/permissions.js';

const router = Router();

const notWeb = () => new HttpError(400, 'No es un pedido en linea', 'NOT_ONLINE_ORDER');

/** Un pedido que espera su pago en linea no se acepta ni se rechaza todavia. */
function assertNotAwaitingPayment(o) {
  if (o.online_payment_status === 'pendiente') {
    throw badRequest('El cliente todavia no completa el pago en linea', 'ONLINE_PAYMENT_PENDING');
  }
}

// Pausa temporal de pedidos en linea de una sucursal (cocina saturada, sin
// repartidor...): el portal la muestra cerrada con el mensaje hasta esa hora.
async function pauseState(db, rid, branchId) {
  const r = (await db.query(
    `SELECT CASE WHEN paused_until > now() THEN paused_until END AS paused_until,
            CASE WHEN paused_until > now() THEN paused_message END AS paused_message
       FROM branch_online_settings WHERE branch_id = $1 AND restaurant_id = $2`,
    [branchId, rid],
  )).rows[0];
  return { paused_until: r?.paused_until ?? null, paused_message: r?.paused_message ?? null };
}

router.get('/online-pause', can('orders'), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  res.json(await withTenant(req.tenant.id, (db) => pauseState(db, req.tenant.id, branchId)));
}));

router.put('/online-pause', can('availability'), ah(async (req, res) => {
  const b = req.body || {};
  const branchId = requireBranch(req, b.branch_id);
  const minutes = Number(b.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) throw badRequest('La pausa debe ser de 5 minutos a 24 horas', 'INVALID_FIELD');
  const message = str(b.message, { field: 'message', max: 200 }) || null;
  const data = await withTenant(req.tenant.id, async (db) => {
    await db.query(
      `INSERT INTO branch_online_settings (restaurant_id, branch_id, paused_until, paused_message)
       VALUES ($1, $2, now() + make_interval(mins => $3::int), $4)
       ON CONFLICT (branch_id) DO UPDATE SET paused_until = EXCLUDED.paused_until, paused_message = EXCLUDED.paused_message, updated_at = now()`,
      [req.tenant.id, branchId, minutes, message],
    );
    return pauseState(db, req.tenant.id, branchId);
  });
  res.json(data);
}));

router.delete('/online-pause', can('availability'), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    await db.query('UPDATE branch_online_settings SET paused_until = NULL, paused_message = NULL, updated_at = now() WHERE branch_id = $1 AND restaurant_id = $2', [branchId, req.tenant.id]);
    return pauseState(db, req.tenant.id, branchId);
  });
  res.json(data);
}));

const LIST_SQL = `
  SELECT o.id, o.branch_id, o.folio, o.order_type, o.status, o.online_status, o.customer_id,
         o.customer_name, o.customer_phone, o.customer_address, o.delivery_reference, o.notes,
         o.delivery_latitude, o.delivery_longitude, o.delivery_distance_km,
         o.subtotal, o.delivery_fee, o.tax_amount, o.total, o.paid_amount,
         o.payment_preference, o.pay_with, o.payment_provider, o.online_payment_status, o.created_at, o.accepted_at, o.estimated_ready_at,
         o.scheduled_for, o.sent_at,
         o.ready_at, o.dispatched_at, o.paid_at, o.cancel_reason
    FROM orders o`;

router.get('/online-orders', can('orders'), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const status = oneOf(req.query.status || 'activas', ['pendientes', 'activas', 'todas'], 'status');
  // Los que esperan el pago en linea todavia no existen para el restaurante.
  let where = `o.restaurant_id = $1 AND o.branch_id = $2 AND o.source = 'web'
    AND o.online_payment_status IS DISTINCT FROM 'pendiente'`;
  if (status === 'pendientes') where += ` AND o.online_status = 'pendiente' AND o.status <> 'cancelada'`;
  else if (status === 'activas') where += ` AND o.status IN ('abierta', 'enviada', 'lista')`;
  else where += ` AND o.created_at > now() - interval '7 days'`;
  const data = await withTenant(req.tenant.id, async (db) => {
    const orders = (await db.query(
      `${LIST_SQL} WHERE ${where}
        ORDER BY (o.online_status = 'pendiente') DESC, o.created_at DESC LIMIT 200`,
      [req.tenant.id, branchId],
    )).rows;
    if (orders.length) {
      const items = await loadItems(db, req.tenant.id, orders.map((o) => o.id));
      for (const o of orders) o.items = items.filter((i) => i.order_id === o.id && !i.voided_at);
    }
    const pending = (await db.query(
      `SELECT count(*)::int AS n FROM orders
        WHERE restaurant_id = $1 AND branch_id = $2 AND source = 'web' AND online_status = 'pendiente' AND status <> 'cancelada'
          AND online_payment_status IS DISTINCT FROM 'pendiente'`,
      [req.tenant.id, branchId],
    )).rows[0].n;
    return { orders, pending_count: pending };
  });
  res.json(data);
}));

router.post('/online-orders/:id/accept', can('cashier'), ah(async (req, res) => {
  const prep = int((req.body || {}).prep_time_minutes, { field: 'prep_time_minutes', min: 1, max: 600 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.source !== 'web') throw notWeb();
    assertActive(o);
    assertNotAwaitingPayment(o);
    if (o.online_status !== 'pendiente') throw badRequest('El pedido ya fue aceptado', 'ALREADY_ACCEPTED');
    const settings = await getOnlineSettings(db, req.tenant.id);
    await acceptOnlineOrder(db, req.tenant.id, o.id, { userId: req.user.id, prepMinutes: prep ?? settings.prep_time_minutes });
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Rechazar: requiere motivo, que el cliente ve en su seguimiento.
router.post('/online-orders/:id/reject', can('cashier'), ah(async (req, res) => {
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, max: 300 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.source !== 'web') throw notWeb();
    assertActive(o);
    assertNotAwaitingPayment(o);
    if (o.online_status !== 'pendiente') {
      throw badRequest('El pedido ya fue aceptado: cancelalo desde la orden si es necesario', 'ALREADY_ACCEPTED');
    }
    // Si ya estaba pagado con Clip, el reembolso se hace desde el panel de
    // Clip; lo pagado con monedero regresa solo al monedero.
    await db.query(
      `UPDATE orders SET status = 'cancelada', online_status = 'rechazada', cancelled_at = now(), cancelled_by = $3,
              cancel_reason = $4, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id, req.user.id, reason],
    );
    await refundOrderWallet(db, req.tenant.id, o, { reason: `Pedido #${o.folio} rechazado`, userId: req.user.id });
    const email = o.customer_id
      ? (await db.query('SELECT email FROM customers WHERE id = $1 AND restaurant_id = $2', [o.customer_id, req.tenant.id])).rows[0]?.email
      : null;
    return { ...(await loadOrder(db, req.tenant.id, o.id)), customer_email: email };
  });
  const { customer_email: email, ...view } = order;
  if (email) void sendOrderRejected(req.tenant, view, email, reason);
  res.json({ order: view });
}));

// Domicilio: el pedido salio con el repartidor (el cliente lo ve "en camino").
router.post('/online-orders/:id/dispatch', can('cashier'), ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.source !== 'web') throw notWeb();
    assertActive(o);
    if (o.order_type !== 'domicilio') throw badRequest('Solo los pedidos a domicilio salen a reparto', 'NOT_DELIVERY');
    if (o.online_status !== 'aceptada') throw badRequest('Acepta el pedido en linea antes de continuar', 'ONLINE_ORDER_PENDING');
    await db.query(
      'UPDATE orders SET dispatched_at = coalesce(dispatched_at, now()), updated_at = now() WHERE id = $1 AND restaurant_id = $2',
      [o.id, req.tenant.id],
    );
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Pedido pagado en linea: al entregarlo (o recogerlo) se cierra sin pasar por
// caja, porque el dinero ya esta en la cuenta de Clip del restaurante.
router.post('/online-orders/:id/deliver', can('cashier'), ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.source !== 'web') throw notWeb();
    assertActive(o);
    if (o.online_status !== 'aceptada') throw badRequest('Acepta el pedido en linea antes de continuar', 'ONLINE_ORDER_PENDING');
    if (o.online_payment_status !== 'pagado' || toCents(o.paid_amount) < toCents(o.total)) {
      throw badRequest('El pedido no esta pagado en linea: cobralo en caja', 'NOT_PAID_ONLINE');
    }
    await db.query(
      `UPDATE order_items SET sent_at = now()
        WHERE order_id = $1 AND restaurant_id = $2 AND sent_at IS NULL AND voided_at IS NULL`,
      [o.id, req.tenant.id],
    );
    await db.query(
      `UPDATE orders SET status = 'pagada', paid_at = now(), sent_at = coalesce(sent_at, now()), updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id],
    );
    await deductOrder(db, req.tenant.id, o.id, req.user.id);
    await earnForOrder(db, req.tenant.id, o.id, req.user.id);
    await redeemOrderVoucher(db, req.tenant.id, o.id);
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

export default router;
