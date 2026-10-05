// Pedidos en linea dentro del POS: lista por sucursal, aceptar (va a
// cocina), rechazar con motivo (el cliente lo ve en el seguimiento) y marcar
// "en camino" los de domicilio. Despues se cobran con el flujo normal de
// pagos (POST /api/pos/orders/:id/payments) y al quedar pagados el cliente
// los ve como entregados.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { acceptOnlineOrder, getOnlineSettings } from '../../services/online.js';
import { HttpError, ah, badRequest, oneOf, str } from '../../utils/http.js';
import { ROLES, int, requireBranch } from './common.js';
import { assertActive, loadItems, loadOrder, lockOrder } from './orders.js';

const router = Router();

const notWeb = () => new HttpError(400, 'No es un pedido en linea', 'NOT_ONLINE_ORDER');

const LIST_SQL = `
  SELECT o.id, o.branch_id, o.folio, o.order_type, o.status, o.online_status, o.customer_id,
         o.customer_name, o.customer_phone, o.customer_address, o.delivery_reference, o.notes,
         o.subtotal, o.delivery_fee, o.tax_amount, o.total, o.paid_amount,
         o.payment_preference, o.pay_with, o.created_at, o.accepted_at, o.estimated_ready_at,
         o.ready_at, o.dispatched_at, o.paid_at, o.cancel_reason
    FROM orders o`;

router.get('/online-orders', requireRole(...ROLES.orders), ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const status = oneOf(req.query.status || 'activas', ['pendientes', 'activas', 'todas'], 'status');
  let where = `o.restaurant_id = $1 AND o.branch_id = $2 AND o.source = 'web'`;
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
        WHERE restaurant_id = $1 AND branch_id = $2 AND source = 'web' AND online_status = 'pendiente' AND status <> 'cancelada'`,
      [req.tenant.id, branchId],
    )).rows[0].n;
    return { orders, pending_count: pending };
  });
  res.json(data);
}));

router.post('/online-orders/:id/accept', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const prep = int((req.body || {}).prep_time_minutes, { field: 'prep_time_minutes', min: 1, max: 600 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.source !== 'web') throw notWeb();
    assertActive(o);
    if (o.online_status !== 'pendiente') throw badRequest('El pedido ya fue aceptado', 'ALREADY_ACCEPTED');
    const settings = await getOnlineSettings(db, req.tenant.id);
    await acceptOnlineOrder(db, req.tenant.id, o.id, { userId: req.user.id, prepMinutes: prep ?? settings.prep_time_minutes });
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Rechazar: requiere motivo, que el cliente ve en su seguimiento.
router.post('/online-orders/:id/reject', requireRole(...ROLES.cashier), ah(async (req, res) => {
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, max: 300 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (o.source !== 'web') throw notWeb();
    assertActive(o);
    if (o.online_status !== 'pendiente') {
      throw badRequest('El pedido ya fue aceptado: cancelalo desde la orden si es necesario', 'ALREADY_ACCEPTED');
    }
    await db.query(
      `UPDATE orders SET status = 'cancelada', online_status = 'rechazada', cancelled_at = now(), cancelled_by = $3,
              cancel_reason = $4, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id, req.user.id, reason],
    );
    return loadOrder(db, req.tenant.id, o.id);
  });
  res.json({ order });
}));

// Domicilio: el pedido salio con el repartidor (el cliente lo ve "en camino").
router.post('/online-orders/:id/dispatch', requireRole(...ROLES.cashier), ah(async (req, res) => {
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

export default router;
