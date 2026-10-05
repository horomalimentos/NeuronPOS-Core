// Corte del repartidor propio: al terminar, entrega el efectivo que cobro en
// la puerta. Se compara contra lo cobrado en sus entregas y esos pagos pasan
// al turno de caja abierto de la sucursal (asi entran al corte de caja).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { driverCut } from '../../services/delivery/math.js';
import {
  HttpError, ah, badRequest, money, requireUuid, str,
} from '../../utils/http.js';
import { ROLES, requireBranch } from '../pos/common.js';

const router = Router();
const cashier = requireRole(...ROLES.cashier);

const PENDING_SQL = `
  SELECT p.id, p.order_id, p.amount, p.tip, p.received, p.change_given, p.created_at, p.driver_user_id,
         o.folio, o.customer_name, d.delivered_at
    FROM order_payments p
    JOIN orders o ON o.id = p.order_id AND o.restaurant_id = p.restaurant_id
    LEFT JOIN order_deliveries d ON d.order_id = p.order_id AND d.restaurant_id = p.restaurant_id AND d.status = 'entregado'
   WHERE p.restaurant_id = $1 AND o.branch_id = $2 AND p.driver_user_id IS NOT NULL AND p.driver_cut_id IS NULL`;

router.get('/driver-cuts', cashier, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const payments = (await db.query(`${PENDING_SQL} ORDER BY p.created_at`, [req.tenant.id, branchId])).rows;
    const drivers = (await db.query(
      `SELECT u.id, u.name FROM users u
        WHERE u.restaurant_id = $1 AND u.role = 'repartidor'
          AND (u.id = ANY($3::uuid[]) OR (u.active AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = $2)))
        ORDER BY u.name`,
      [req.tenant.id, branchId, [...new Set(payments.map((p) => p.driver_user_id))]],
    )).rows;
    const active = (await db.query(
      `SELECT driver_user_id, count(*)::int AS n FROM order_deliveries
        WHERE restaurant_id = $1 AND branch_id = $2 AND status IN ('asignado', 'recogido', 'en_camino')
        GROUP BY driver_user_id`,
      [req.tenant.id, branchId],
    )).rows;
    const pending = drivers.map((d) => {
      const mine = payments.filter((p) => p.driver_user_id === d.id);
      return {
        driver_user_id: d.id,
        name: d.name,
        active_deliveries: active.find((a) => a.driver_user_id === d.id)?.n || 0,
        ...driverCut(mine),
        payments: mine,
      };
    });
    const cuts = (await db.query(
      `SELECT c.id, c.driver_user_id, u.name AS driver_name, c.cash_session_id, s.terminal, c.expected_cash, c.counted_cash,
              c.difference, c.deliveries_count, c.notes, c.created_at, uc.name AS created_by_name
         FROM driver_cash_cuts c
         JOIN users u ON u.id = c.driver_user_id AND u.restaurant_id = c.restaurant_id
         JOIN users uc ON uc.id = c.created_by AND uc.restaurant_id = c.restaurant_id
         JOIN cash_sessions s ON s.id = c.cash_session_id AND s.restaurant_id = c.restaurant_id
        WHERE c.restaurant_id = $1 AND c.branch_id = $2 ORDER BY c.created_at DESC LIMIT 50`,
      [req.tenant.id, branchId],
    )).rows;
    return { pending, cuts };
  });
  res.json(data);
}));

router.post('/driver-cuts', cashier, ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const driverId = requireUuid(body.driver_user_id, 'driver_user_id');
  const sessionId = requireUuid(body.cash_session_id, 'cash_session_id');
  const counted = money(body.counted_cash, { field: 'counted_cash' });
  if (counted === undefined) throw badRequest('Captura el efectivo que entrega el repartidor', 'MISSING_FIELD');
  const notes = str(body.notes, { field: 'notes', max: 300 }) || null;

  const result = await withTenant(req.tenant.id, async (db) => {
    const session = (await db.query(
      'SELECT id, branch_id, status FROM cash_sessions WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [sessionId, req.tenant.id],
    )).rows[0];
    if (!session || session.status !== 'abierta' || session.branch_id !== branchId) {
      throw badRequest('Abre la caja de esta sucursal antes de hacer el corte del repartidor', 'CASH_SESSION_REQUIRED');
    }
    const payments = (await db.query(
      `${PENDING_SQL} AND p.driver_user_id = $3 ORDER BY p.created_at FOR UPDATE OF p`,
      [req.tenant.id, branchId, driverId],
    )).rows;
    if (!payments.length) throw new HttpError(409, 'El repartidor no tiene efectivo pendiente de entregar', 'NOTHING_TO_SETTLE');
    const cut = driverCut(payments, counted);
    const row = (await db.query(
      `INSERT INTO driver_cash_cuts (restaurant_id, branch_id, driver_user_id, cash_session_id, expected_cash,
                                     counted_cash, difference, deliveries_count, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.tenant.id, branchId, driverId, session.id, cut.expected_cash, cut.counted_cash, cut.difference,
        cut.deliveries_count, notes, req.user.id],
    )).rows[0];
    await db.query(
      `UPDATE order_payments SET cash_session_id = $3, driver_cut_id = $4
        WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
      [req.tenant.id, payments.map((p) => p.id), session.id, row.id],
    );
    return { cut: row, payments };
  });
  res.status(201).json(result);
}));

export default router;
