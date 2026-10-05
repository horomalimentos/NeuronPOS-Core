// App del repartidor propio (/repartidor): solo usuarios con rol
// 'repartidor'. Ve unicamente los pedidos que la caja le asigno.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { DELIVERY_STATUS_LABEL, DRIVER_STATUSES } from '../../services/delivery/flow.js';
import { readLocation } from '../../services/delivery/location.js';
import { applyOwnTransition } from '../../services/delivery/tenant.js';
import { mapsUrl } from '../../services/online.js';
import { fromCents, toCents } from '../../services/posMath.js';
import {
  ah, badRequest, bool, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';

const router = Router();
router.use(requireRole('repartidor'));

const SELECT = `
  SELECT d.id, d.order_id, d.status, d.cash_to_collect, d.cash_collected, d.fail_reason, d.assigned_at,
         d.picked_up_at, d.on_way_at, d.delivered_at, d.failed_at,
         o.folio, o.customer_name, o.customer_phone, o.customer_address, o.delivery_reference, o.notes,
         o.total, o.paid_amount, o.payment_preference, o.pay_with, o.status AS order_status,
         b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone
    FROM order_deliveries d
    JOIN orders o ON o.id = d.order_id AND o.restaurant_id = d.restaurant_id
    JOIN branches b ON b.id = d.branch_id AND b.restaurant_id = d.restaurant_id`;

function view(r, items = []) {
  return {
    ...r,
    status_label: DELIVERY_STATUS_LABEL[r.status],
    // Lo que falta por cobrar en la puerta (puede cambiar si la caja cobra antes).
    remaining: fromCents(Math.max(0, toCents(r.total) - toCents(r.paid_amount))),
    maps_url: mapsUrl(r.customer_address),
    waze_url: r.customer_address ? `https://waze.com/ul?q=${encodeURIComponent(r.customer_address)}&navigate=yes` : null,
    items: items.filter((i) => i.order_id === r.order_id),
  };
}

async function loadItems(db, rid, orderIds) {
  if (!orderIds.length) return [];
  return (await db.query(
    `SELECT order_id, name, quantity, notes FROM order_items
      WHERE restaurant_id = $1 AND order_id = ANY($2::uuid[]) AND voided_at IS NULL ORDER BY created_at, id`,
    [rid, orderIds],
  )).rows;
}

router.get('/deliveries', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const rows = (await db.query(
      `${SELECT}
        WHERE d.restaurant_id = $1 AND d.driver_user_id = $2
          AND (d.status IN ('asignado', 'recogido', 'en_camino') OR d.updated_at > now() - interval '18 hours')
        ORDER BY (d.status IN ('asignado', 'recogido', 'en_camino')) DESC, d.assigned_at DESC LIMIT 100`,
      [req.tenant.id, req.user.id],
    )).rows;
    const items = await loadItems(db, req.tenant.id, rows.map((r) => r.order_id));
    const duty = (await db.query(
      'SELECT on_duty, located_at FROM driver_locations WHERE restaurant_id = $1 AND user_id = $2',
      [req.tenant.id, req.user.id],
    )).rows[0];
    const cash = (await db.query(
      `SELECT coalesce(sum(amount + tip), 0)::numeric(10,2) AS total, count(DISTINCT order_id)::int AS orders
         FROM order_payments WHERE restaurant_id = $1 AND driver_user_id = $2 AND driver_cut_id IS NULL`,
      [req.tenant.id, req.user.id],
    )).rows[0];
    return {
      deliveries: rows.map((r) => view(r, items)),
      on_duty: Boolean(duty?.on_duty),
      located_at: duty?.located_at ?? null,
      cash_pending: cash.total,
      cash_orders: cash.orders,
    };
  });
  res.json(data);
}));

router.post('/deliveries/:id/status', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const status = oneOf(body.status, DRIVER_STATUSES, 'status');
  if (!status) throw badRequest('Indica el nuevo estado', 'MISSING_FIELD');
  const delivery = await withTenant(req.tenant.id, async (db) => {
    const d = (await db.query(
      'SELECT * FROM order_deliveries WHERE id = $1 AND restaurant_id = $2 AND driver_user_id = $3 FOR UPDATE',
      [req.params.id, req.tenant.id, req.user.id],
    )).rows[0];
    if (!d) throw notFound('Pedido no encontrado', 'DELIVERY_NOT_FOUND');
    await applyOwnTransition(db, req.tenant.id, d, status, {
      actorId: req.user.id,
      reason: str(body.reason, { field: 'reason', max: 300 }) || null,
      received: money(body.received, { field: 'received', nullable: true }) ?? undefined,
      tip: money(body.tip ?? 0, { field: 'tip' }),
    });
    const row = (await db.query(`${SELECT} WHERE d.id = $1 AND d.restaurant_id = $2`, [d.id, req.tenant.id])).rows[0];
    return view(row, await loadItems(db, req.tenant.id, [row.order_id]));
  });
  res.json({ delivery });
}));

// Turno: mientras esta en turno la app manda su ubicacion cada ~20 s.
router.post('/duty', ah(async (req, res) => {
  const onDuty = bool((req.body || {}).on_duty, 'on_duty');
  if (onDuty === undefined) throw badRequest('Indica si estas en turno', 'MISSING_FIELD');
  await withTenant(req.tenant.id, (db) => db.query(
    `INSERT INTO driver_locations (restaurant_id, user_id, on_duty) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET on_duty = $3, updated_at = now()`,
    [req.tenant.id, req.user.id, onDuty],
  ));
  res.json({ on_duty: onDuty });
}));

router.post('/location', ah(async (req, res) => {
  const loc = readLocation(req.body);
  await withTenant(req.tenant.id, (db) => db.query(
    `INSERT INTO driver_locations (restaurant_id, user_id, on_duty, latitude, longitude, accuracy_m, located_at)
     VALUES ($1, $2, true, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET on_duty = true, latitude = $3, longitude = $4, accuracy_m = $5,
                                          located_at = now(), updated_at = now()`,
    [req.tenant.id, req.user.id, loc.latitude, loc.longitude, loc.accuracy],
  ));
  res.json({ ok: true });
}));

export default router;
