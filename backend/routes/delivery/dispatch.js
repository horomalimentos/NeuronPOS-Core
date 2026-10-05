// Pantalla de reparto (caja): pedidos a domicilio de la sucursal, asignar
// repartidor propio (la caja elige quien se lleva el pedido), cambiar
// estados, pedir repartidor a la flota y mapa en vivo.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { autoOffer } from '../../services/delivery/fleet.js';
import { DELIVERY_STATUSES } from '../../services/delivery/flow.js';
import { commissionAmount } from '../../services/delivery/math.js';
import {
  applyOwnTransition, assertDispatchable, assertNoActiveDelivery, branchDrivers, dispatchOrders,
  getDeliveryConfig, lockOrderRow,
} from '../../services/delivery/tenant.js';
import { fromCents, toCents } from '../../services/posMath.js';
import {
  HttpError, ah, badRequest, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { ROLES, canAccessBranch, isManager, requireBranch } from '../pos/common.js';

const router = Router();
const cashier = requireRole(...ROLES.cashier);
const conflict = (msg, code) => new HttpError(409, msg, code);

// Una ubicacion mas vieja que esto no se muestra en el mapa.
const FRESH_MINUTES = 15;

router.get('/board', cashier, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => ({
    settings: await getDeliveryConfig(db, req.tenant.id),
    orders: await dispatchOrders(db, req.tenant.id, branchId),
    drivers: await branchDrivers(db, req.tenant.id, branchId),
  }));
  // Las condiciones de la flota solo las ven admin y gerente.
  const { mode, horom_enabled: horomEnabled } = data.settings;
  res.json({ ...data, settings: isManager(req.user) ? data.settings : { mode, horom_enabled: horomEnabled } });
}));

/** Reparto propio con su orden, validando la sucursal del usuario. */
async function lockOwnDelivery(db, req, id) {
  requireUuid(id);
  const d = (await db.query(
    'SELECT * FROM order_deliveries WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
    [id, req.tenant.id],
  )).rows[0];
  if (!d || !canAccessBranch(req.user, d.branch_id)) throw notFound('Reparto no encontrado', 'DELIVERY_NOT_FOUND');
  return d;
}

// Asignar (o cambiar, mientras no lo recoja) el repartidor propio de un pedido.
router.post('/orders/:id/assign', cashier, ah(async (req, res) => {
  requireUuid(req.params.id);
  const driverId = requireUuid((req.body || {}).driver_user_id, 'driver_user_id');
  const delivery = await withTenant(req.tenant.id, async (db) => {
    const s = await getDeliveryConfig(db, req.tenant.id);
    if (s.mode !== 'propio') throw conflict('Tu restaurante usa el servicio de repartidores de NeuronPOS: pide un repartidor', 'MODE_HOROM');
    const o = await lockOrderRow(db, req.tenant.id, req.params.id);
    if (!canAccessBranch(req.user, o.branch_id)) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
    assertDispatchable(o);
    const driver = (await db.query(
      `SELECT u.id FROM users u
        WHERE u.id = $1 AND u.restaurant_id = $2 AND u.role = 'repartidor' AND u.active
          AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = $3)`,
      [driverId, req.tenant.id, o.branch_id],
    )).rows[0];
    if (!driver) throw badRequest('El repartidor no existe o no es de esta sucursal', 'DRIVER_NOT_FOUND');

    const current = (await db.query(
      `SELECT * FROM order_deliveries
        WHERE restaurant_id = $1 AND order_id = $2 AND status NOT IN ('fallido', 'cancelado') FOR UPDATE`,
      [req.tenant.id, o.id],
    )).rows[0];
    if (current) {
      if (current.status !== 'asignado') throw conflict('El repartidor ya recogio el pedido', 'DELIVERY_IN_PROGRESS');
      return (await db.query(
        `UPDATE order_deliveries SET driver_user_id = $3, assigned_by = $4, assigned_at = now(), updated_at = now()
          WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
        [current.id, req.tenant.id, driver.id, req.user.id],
      )).rows[0];
    }
    await assertNoActiveDelivery(db, req.tenant.id, o.id);
    if (o.status === 'pagada' && o.dispatched_at) throw conflict('El pedido ya se entrego', 'DELIVERY_EXISTS');
    return (await db.query(
      `INSERT INTO order_deliveries (restaurant_id, order_id, branch_id, driver_user_id, cash_to_collect, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.tenant.id, o.id, o.branch_id, driver.id, fromCents(toCents(o.total) - toCents(o.paid_amount)), req.user.id],
    )).rows[0];
  });
  res.status(201).json({ delivery });
}));

// Estados desde la caja (p. ej. "entregado a repartidor" = recogido, o
// entregado cuando el repartidor regresa). Cobro en la puerta: received/tip.
router.post('/deliveries/:id/status', cashier, ah(async (req, res) => {
  const body = req.body || {};
  const status = oneOf(body.status, DELIVERY_STATUSES, 'status');
  if (!status) throw badRequest('Indica el nuevo estado', 'MISSING_FIELD');
  const reason = str(body.reason, { field: 'reason', max: 300 }) || null;
  const delivery = await withTenant(req.tenant.id, async (db) => {
    const d = await lockOwnDelivery(db, req, req.params.id);
    return applyOwnTransition(db, req.tenant.id, d, status, {
      actorId: req.user.id,
      reason: status === 'cancelado' ? (reason || 'Cancelado en caja') : reason,
      received: money(body.received, { field: 'received', nullable: true }) ?? undefined,
      tip: money(body.tip ?? 0, { field: 'tip' }),
    });
  });
  res.json({ delivery });
}));

// ---------------------------------------------------------------------------
// Flota de la plataforma (modo horom)
// ---------------------------------------------------------------------------

router.post('/orders/:id/request', cashier, ah(async (req, res) => {
  requireUuid(req.params.id);
  const notes = str((req.body || {}).notes, { field: 'notes', max: 300 }) || null;
  const request = await withTenant(req.tenant.id, async (db) => {
    const s = await getDeliveryConfig(db, req.tenant.id);
    if (!s.horom_enabled || s.mode !== 'horom') {
      throw new HttpError(403, 'Tu restaurante no tiene activo el servicio de repartidores de NeuronPOS', 'HOROM_NOT_ENABLED');
    }
    const o = await lockOrderRow(db, req.tenant.id, req.params.id);
    if (!canAccessBranch(req.user, o.branch_id)) throw notFound('Orden no encontrada', 'ORDER_NOT_FOUND');
    assertDispatchable(o);
    await assertNoActiveDelivery(db, req.tenant.id, o.id);
    if (o.status === 'pagada' && o.dispatched_at) throw conflict('El pedido ya se entrego', 'DELIVERY_EXISTS');
    const branch = (await db.query(
      'SELECT name, address, phone FROM branches WHERE id = $1 AND restaurant_id = $2',
      [o.branch_id, req.tenant.id],
    )).rows[0];
    const fee = { type: s.horom_fee_type, value: s.horom_fee_value };
    const orderNotes = [o.notes, notes].filter(Boolean).join(' · ') || null;
    return (await db.query(
      `INSERT INTO delivery_requests (restaurant_id, branch_id, order_id, requested_by, restaurant_name, order_folio,
                                      pickup_name, pickup_address, pickup_phone, customer_name, customer_phone,
                                      dropoff_address, dropoff_reference, notes, order_subtotal, order_total,
                                      cash_to_collect, pay_with, commission_type, commission_value, commission_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      [req.tenant.id, o.branch_id, o.id, req.user.id, req.tenant.name, o.folio, branch.name, branch.address, branch.phone,
        o.customer_name || 'Cliente', o.customer_phone, o.customer_address, o.delivery_reference, orderNotes,
        o.subtotal, o.total, fromCents(toCents(o.total) - toCents(o.paid_amount)),
        o.payment_preference === 'efectivo' ? o.pay_with : null,
        fee.type, fee.value, commissionAmount(fee, o.subtotal)],
    )).rows[0];
  });
  await autoOffer(request.id);
  res.status(201).json({ request });
}));

// El restaurante cancela su solicitud mientras el repartidor no recoja el pedido.
router.post('/requests/:id/cancel', cashier, ah(async (req, res) => {
  requireUuid(req.params.id);
  const reason = str((req.body || {}).reason, { field: 'reason', max: 300 }) || 'Cancelado por el restaurante';
  const request = await withTenant(req.tenant.id, async (db) => {
    const r = (await db.query(
      'SELECT * FROM delivery_requests WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [req.params.id, req.tenant.id],
    )).rows[0];
    if (!r || !canAccessBranch(req.user, r.branch_id)) throw notFound('Solicitud no encontrada', 'REQUEST_NOT_FOUND');
    if (!['solicitado', 'asignado'].includes(r.status)) {
      throw conflict('El repartidor ya recogio el pedido: comunicate con NeuronPOS', 'INVALID_TRANSITION');
    }
    await db.query(
      `UPDATE orders SET dispatched_at = NULL, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2 AND status IN ('enviada', 'lista')`,
      [r.order_id, req.tenant.id],
    );
    return (await db.query(
      `UPDATE delivery_requests SET status = 'cancelado', cancelled_at = now(), cancel_reason = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [r.id, reason],
    )).rows[0];
  });
  res.json({ request });
}));

// ---------------------------------------------------------------------------
// Mapa en vivo: repartidores propios en turno y los de la flota que llevan
// pedidos de este restaurante (RLS no deja ver a ningun otro).
// ---------------------------------------------------------------------------

router.get('/map', cashier, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const own = (await db.query(
      `SELECT u.id, u.name, l.latitude, l.longitude, l.accuracy_m, l.located_at,
              (SELECT o.folio FROM order_deliveries d JOIN orders o ON o.id = d.order_id AND o.restaurant_id = d.restaurant_id
                WHERE d.restaurant_id = u.restaurant_id AND d.driver_user_id = u.id
                  AND d.status IN ('asignado', 'recogido', 'en_camino')
                ORDER BY d.assigned_at DESC LIMIT 1) AS folio
         FROM driver_locations l JOIN users u ON u.id = l.user_id AND u.restaurant_id = l.restaurant_id
        WHERE l.restaurant_id = $1 AND l.on_duty AND l.latitude IS NOT NULL
          AND l.located_at > now() - make_interval(mins => $3)
          AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = $2)`,
      [req.tenant.id, branchId, FRESH_MINUTES],
    )).rows.map((r) => ({ kind: 'propio', ...r }));
    const fleet = (await db.query(
      `SELECT r.driver_id AS id, r.driver_name AS name, r.order_folio AS folio, r.status,
              l.latitude, l.longitude, l.accuracy_m, l.updated_at AS located_at
         FROM delivery_requests r
         JOIN fleet_driver_locations l ON l.driver_id = r.driver_id
        WHERE r.restaurant_id = $1 AND r.branch_id = $2 AND r.status IN ('asignado', 'recogido', 'en_camino')
          AND l.updated_at > now() - make_interval(mins => $3)`,
      [req.tenant.id, branchId, FRESH_MINUTES],
    )).rows.map((r) => ({ kind: 'horom', ...r }));
    return { drivers: [...own, ...fleet] };
  });
  res.json(data);
}));

export default router;
