// Nomina: ajustes manuales (bonos, descuentos, prestamos), periodos
// (generar -> calcular -> revisar -> aprobar -> pagar -> cerrar), recibos,
// reporte CSV y pago desde la caja del POS.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { env } from '../../config/env.js';
import { getPayrollSettings, moduleActive } from '../../services/rh/attendance.js';
import { localToday } from '../../services/rh/dates.js';
import {
  ITEM_COLUMNS, ITEM_FROM, PERIOD_COLUMNS, PERIOD_FROM, calculatePeriod, getPeriod, itemLines, periodCsv,
} from '../../services/rh/payroll.js';
import { FREQUENCIES, periodRange } from '../../services/rh/payrollMath.js';
import {
  HttpError, ah, badRequest, bool, buildSet, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { dateField } from '../employees.js';
import { canAccessBranch } from '../pos/common.js';
import { adminOnly, manager } from './common.js';

const router = Router();

// --- Ajustes manuales ---

const ADJ_SELECT = `
  SELECT a.id, a.employee_id, e.full_name AS employee_name, a.kind, a.concept, a.amount, a.recurrence,
         to_char(a.apply_date, 'YYYY-MM-DD') AS apply_date, to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
         to_char(a.end_date, 'YYYY-MM-DD') AS end_date, a.total_amount, a.active, a.source, a.notes, a.created_at,
         coalesce((SELECT sum(l.amount) FROM payroll_item_lines l WHERE l.restaurant_id = a.restaurant_id AND l.adjustment_id = a.id), 0) AS applied_amount
    FROM payroll_adjustments a
    JOIN employees e ON e.id = a.employee_id AND e.restaurant_id = a.restaurant_id`;

function adjustmentFields(b, creating) {
  const f = {
    kind: oneOf(b.kind, ['bono', 'descuento', 'prestamo'], 'kind'),
    concept: str(b.concept, { field: 'concept', required: creating, max: 120 }),
    amount: money(b.amount, { field: 'amount' }),
    recurrence: oneOf(b.recurrence, ['unico', 'cada_periodo'], 'recurrence'),
    apply_date: dateField(b.apply_date, 'apply_date'),
    start_date: dateField(b.start_date, 'start_date'),
    end_date: dateField(b.end_date, 'end_date'),
    total_amount: money(b.total_amount, { field: 'total_amount', nullable: true }),
    active: bool(b.active, 'active'),
    notes: str(b.notes, { field: 'notes', max: 500 }),
  };
  if (creating && !f.kind) throw badRequest('Indica si es bono, descuento o préstamo', 'MISSING_FIELD');
  if (f.amount !== undefined && !(f.amount > 0)) throw badRequest('El monto debe ser mayor a cero', 'INVALID_FIELD');
  if (f.kind === 'prestamo' && creating) {
    if (!(f.total_amount > 0)) throw badRequest('Indica el total prestado', 'MISSING_FIELD');
    f.recurrence = f.recurrence || 'cada_periodo';
  }
  if (creating) {
    f.recurrence = f.recurrence || 'unico';
    if (f.recurrence === 'unico' && !f.apply_date) throw badRequest('Indica la fecha en que se aplica', 'MISSING_FIELD');
    if (f.recurrence === 'cada_periodo' && !f.start_date) throw badRequest('Indica desde cuándo se aplica', 'MISSING_FIELD');
  }
  return f;
}

router.get('/adjustments', manager, ah(async (req, res) => {
  const params = [req.tenant.id];
  let where = 'a.restaurant_id = $1';
  if (req.query.employee_id) { params.push(requireUuid(req.query.employee_id, 'employee_id')); where += ` AND a.employee_id = $${params.length}`; }
  if (req.query.active === '1') where += ' AND a.active';
  const adjustments = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${ADJ_SELECT} WHERE ${where} ORDER BY a.created_at DESC LIMIT 500`, params,
  )).rows);
  res.json({ adjustments });
}));

router.post('/adjustments', manager, ah(async (req, res) => {
  const b = req.body || {};
  const employeeId = requireUuid(b.employee_id, 'employee_id');
  const f = adjustmentFields(b, true);
  const adjustment = await withTenant(req.tenant.id, async (db) => {
    const ok = await db.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [employeeId, req.tenant.id]);
    if (!ok.rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
    const cols = Object.entries(f).filter(([, v]) => v !== undefined);
    const { rows } = await db.query(
      `INSERT INTO payroll_adjustments (restaurant_id, employee_id, created_by, ${cols.map(([k]) => k).join(', ')})
       VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
      [req.tenant.id, employeeId, req.user.id, ...cols.map(([, v]) => v)],
    );
    return (await db.query(`${ADJ_SELECT} WHERE a.id = $1 AND a.restaurant_id = $2`, [rows[0].id, req.tenant.id])).rows[0];
  });
  res.status(201).json({ adjustment });
}));

router.patch('/adjustments/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = adjustmentFields(req.body || {}, false);
  delete f.kind;
  const set = buildSet(f, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const adjustment = await withTenant(req.tenant.id, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE payroll_adjustments SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.tenant.id, ...set.values],
    );
    if (!rowCount) throw notFound('Ajuste no encontrado', 'ADJUSTMENT_NOT_FOUND');
    return (await db.query(`${ADJ_SELECT} WHERE a.id = $1 AND a.restaurant_id = $2`, [req.params.id, req.tenant.id])).rows[0];
  });
  res.json({ adjustment });
}));

// Un ajuste que ya salio en algun recibo no se borra: se desactiva.
router.delete('/adjustments/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const used = await db.query('SELECT 1 FROM payroll_item_lines WHERE restaurant_id = $1 AND adjustment_id = $2 LIMIT 1', [req.tenant.id, req.params.id]);
    if (used.rowCount) throw new HttpError(409, 'El ajuste ya se aplicó en una nómina: desactívalo en lugar de borrarlo', 'ADJUSTMENT_APPLIED');
    await db.query('UPDATE recognition_results SET adjustment_id = NULL WHERE restaurant_id = $1 AND adjustment_id = $2', [req.tenant.id, req.params.id]);
    await db.query('UPDATE customer_complaints SET payroll_adjustment_id = NULL WHERE restaurant_id = $1 AND payroll_adjustment_id = $2', [req.tenant.id, req.params.id]);
    const { rowCount } = await db.query('DELETE FROM payroll_adjustments WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Ajuste no encontrado', 'ADJUSTMENT_NOT_FOUND');
  });
  res.status(204).end();
}));

// --- Periodos ---

router.get('/payroll/periods', manager, ah(async (req, res) => {
  const periods = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${PERIOD_COLUMNS},
            (SELECT count(*)::int FROM payroll_items i WHERE i.period_id = p.id AND i.restaurant_id = p.restaurant_id AND i.paid_at IS NOT NULL) AS paid_count,
            (SELECT count(*)::int FROM payroll_receipt_signatures s JOIN payroll_items i ON i.id = s.item_id
              WHERE i.period_id = p.id AND s.restaurant_id = p.restaurant_id) AS signed_count
       FROM ${PERIOD_FROM} WHERE p.restaurant_id = $1 ORDER BY p.start_date DESC, p.frequency LIMIT 200`,
    [req.tenant.id],
  )).rows);
  res.json({ periods });
}));

// Genera el periodo que contiene `date` (hoy si no viene) y lo calcula.
// Idempotente: si ya existe se regresa el mismo (200) sin duplicar.
router.post('/payroll/periods', manager, ah(async (req, res) => {
  const b = req.body || {};
  const frequency = oneOf(b.frequency, FREQUENCIES, 'frequency');
  if (!frequency) throw badRequest('Indica la frecuencia', 'MISSING_FIELD');
  const result = await withTenant(req.tenant.id, async (db) => {
    const settings = await getPayrollSettings(db, req.tenant.id);
    const date = dateField(b.date, 'date') || localToday(env.billingTimezone);
    const range = periodRange(frequency, date, Number(settings.week_start_day));
    const ins = await db.query(
      `INSERT INTO payroll_periods (restaurant_id, frequency, start_date, end_date, created_by)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (restaurant_id, frequency, start_date) DO NOTHING RETURNING id`,
      [req.tenant.id, frequency, range.start, range.end, req.user.id],
    );
    let created = false;
    let id;
    let skipped = [];
    if (ins.rowCount) {
      created = true;
      id = ins.rows[0].id;
      ({ skipped } = await calculatePeriod(db, req.tenant.id, id, { userId: req.user.id }));
    } else {
      id = (await db.query(
        'SELECT id FROM payroll_periods WHERE restaurant_id = $1 AND frequency = $2 AND start_date = $3',
        [req.tenant.id, frequency, range.start],
      )).rows[0].id;
    }
    return { created, period: await getPeriod(db, req.tenant.id, id), skipped };
  });
  res.status(result.created ? 201 : 200).json(result);
}));

async function periodDetail(db, restaurantId, id) {
  const period = await getPeriod(db, restaurantId, id);
  if (!period) throw notFound('Periodo no encontrado', 'PERIOD_NOT_FOUND');
  const items = (await db.query(
    `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.restaurant_id = $1 AND i.period_id = $2 ORDER BY i.employee_name, i.id`,
    [restaurantId, id],
  )).rows;
  const lines = await itemLines(db, restaurantId, items.map((i) => i.id));
  return { period, items: items.map((i) => ({ ...i, lines: lines.get(i.id) })) };
}

router.get('/payroll/periods/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  res.json(await withTenant(req.tenant.id, (db) => periodDetail(db, req.tenant.id, req.params.id)));
}));

router.post('/payroll/periods/:id/calculate', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const { skipped } = await calculatePeriod(db, req.tenant.id, req.params.id, { userId: req.user.id });
    return { ...(await periodDetail(db, req.tenant.id, req.params.id)), skipped };
  });
  res.json(data);
}));

async function transition(req, from, to, extra = async () => {}) {
  requireUuid(req.params.id);
  return withTenant(req.tenant.id, async (db) => {
    const p = await getPeriod(db, req.tenant.id, req.params.id, { lock: true });
    if (!p) throw notFound('Periodo no encontrado', 'PERIOD_NOT_FOUND');
    if (p.status !== from) throw new HttpError(409, `El periodo está ${p.status}`, 'INVALID_PERIOD_STATUS');
    await extra(db, p);
    const cols = { aprobada: 'approved', cerrada: 'closed' }[to];
    await db.query(
      `UPDATE payroll_periods SET status = $3${cols ? `, ${cols}_at = now(), ${cols}_by = $4` : ', approved_at = NULL, approved_by = NULL'}
        WHERE id = $1 AND restaurant_id = $2`,
      cols ? [p.id, req.tenant.id, to, req.user.id] : [p.id, req.tenant.id, to],
    );
    return periodDetail(db, req.tenant.id, p.id);
  });
}

// Aprobar: los recibos quedan fijos y los empleados ya pueden verlos y firmarlos.
router.post('/payroll/periods/:id/approve', adminOnly, ah(async (req, res) => {
  res.json(await transition(req, 'borrador', 'aprobada', async (db, p) => {
    if (!p.calculated_at || p.employees_count === 0) throw badRequest('El periodo no tiene recibos calculados', 'PERIOD_EMPTY');
  }));
}));

// Reabrir (para corregir) solo si nadie ha cobrado ni firmado.
router.post('/payroll/periods/:id/reopen', adminOnly, ah(async (req, res) => {
  res.json(await transition(req, 'aprobada', 'borrador', async (db, p) => {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE i.paid_at IS NOT NULL)::int AS paid, count(s.id)::int AS signed
         FROM payroll_items i LEFT JOIN payroll_receipt_signatures s ON s.item_id = i.id AND s.restaurant_id = i.restaurant_id
        WHERE i.restaurant_id = $1 AND i.period_id = $2`,
      [req.tenant.id, p.id],
    );
    if (rows[0].paid || rows[0].signed) {
      throw new HttpError(409, 'No se puede reabrir: ya hay recibos pagados o firmados', 'PERIOD_HAS_ACTIVITY');
    }
  }));
}));

// Cerrar: todos los recibos deben estar pagados.
router.post('/payroll/periods/:id/close', adminOnly, ah(async (req, res) => {
  res.json(await transition(req, 'aprobada', 'cerrada', async (db, p) => {
    const { rows } = await db.query(
      'SELECT count(*)::int AS unpaid FROM payroll_items WHERE restaurant_id = $1 AND period_id = $2 AND paid_at IS NULL',
      [req.tenant.id, p.id],
    );
    if (rows[0].unpaid) throw new HttpError(409, `Faltan ${rows[0].unpaid} recibo(s) por pagar`, 'PERIOD_UNPAID');
  }));
}));

router.get('/payroll/periods/:id/export.csv', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const { period, items } = await withTenant(req.tenant.id, (db) => periodDetail(db, req.tenant.id, req.params.id));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="nomina-${period.frequency}-${period.start_date}.csv"`);
  res.send(periodCsv(period, items));
}));

// --- Recibos y pagos ---

router.get('/payroll/items/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const item = (await db.query(`SELECT ${ITEM_COLUMNS}, i.detail FROM ${ITEM_FROM} WHERE i.id = $1 AND i.restaurant_id = $2`, [req.params.id, req.tenant.id])).rows[0];
    if (!item) throw notFound('Recibo no encontrado', 'ITEM_NOT_FOUND');
    item.lines = (await itemLines(db, req.tenant.id, [item.id])).get(item.id);
    return { item, period: await getPeriod(db, req.tenant.id, item.period_id) };
  });
  res.json(data);
}));

const PAY_METHODS = ['caja', 'efectivo', 'transferencia', 'otro'];

/**
 * Marca un recibo como pagado. Con method = 'caja' (requiere el modulo pos)
 * se registra una salida de efectivo en el turno de caja abierto indicado,
 * como en el sistema original.
 */
async function payItem(db, req, item, method, cashSessionId) {
  if (item.paid_at) throw new HttpError(409, `El recibo de ${item.employee_name} ya está pagado`, 'ITEM_ALREADY_PAID');
  let movementId = null;
  if (method === 'caja') {
    if (!(await moduleActive(db, req.tenant.id, 'pos'))) {
      throw new HttpError(402, 'Para pagar desde la caja se necesita el módulo "Punto de venta"', 'MODULE_NOT_ENABLED', { module: 'pos' });
    }
    requireUuid(cashSessionId, 'cash_session_id');
    await db.query('SELECT 1 FROM cash_sessions WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [cashSessionId, req.tenant.id]);
    const s = (await db.query('SELECT id, branch_id, status FROM cash_sessions WHERE id = $1 AND restaurant_id = $2', [cashSessionId, req.tenant.id])).rows[0];
    if (!s || !canAccessBranch(req.user, s.branch_id)) throw notFound('Turno de caja no encontrado', 'CASH_SESSION_NOT_FOUND');
    if (s.status !== 'abierta') throw badRequest('El turno de caja ya está cerrado', 'CASH_SESSION_CLOSED');
    if (Number(item.net) > 0) {
      movementId = (await db.query(
        `INSERT INTO cash_movements (restaurant_id, session_id, kind, amount, reason, created_by)
         VALUES ($1, $2, 'salida', $3, $4, $5) RETURNING id`,
        [req.tenant.id, s.id, item.net, `Nómina ${item.employee_name} (${item.start_date} al ${item.end_date})`, req.user.id],
      )).rows[0].id;
    }
  }
  await db.query(
    `UPDATE payroll_items SET paid_at = now(), paid_method = $3, paid_by = $4, cash_movement_id = $5, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [item.id, req.tenant.id, method, req.user.id, movementId],
  );
  return movementId;
}

async function lockItem(db, restaurantId, id) {
  const item = (await db.query(
    `SELECT i.id, i.period_id, i.employee_name, i.net, i.paid_at, p.status,
            to_char(p.start_date, 'YYYY-MM-DD') AS start_date, to_char(p.end_date, 'YYYY-MM-DD') AS end_date
       FROM payroll_items i JOIN payroll_periods p ON p.id = i.period_id AND p.restaurant_id = i.restaurant_id
      WHERE i.id = $1 AND i.restaurant_id = $2 FOR UPDATE OF i`,
    [id, restaurantId],
  )).rows[0];
  if (!item) throw notFound('Recibo no encontrado', 'ITEM_NOT_FOUND');
  return item;
}

router.post('/payroll/items/:id/pay', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const method = oneOf(req.body?.method, PAY_METHODS, 'method');
  if (!method) throw badRequest('Indica la forma de pago', 'MISSING_FIELD');
  const data = await withTenant(req.tenant.id, async (db) => {
    const item = await lockItem(db, req.tenant.id, req.params.id);
    if (item.status !== 'aprobada') throw new HttpError(409, 'Solo se pagan nóminas aprobadas', 'INVALID_PERIOD_STATUS');
    const movementId = await payItem(db, req, item, method, req.body?.cash_session_id);
    return { ok: true, cash_movement_id: movementId };
  });
  res.json(data);
}));

// Pagar todos los pendientes de un periodo con la misma forma (no caja).
router.post('/payroll/periods/:id/pay-all', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const method = oneOf(req.body?.method, ['efectivo', 'transferencia', 'otro'], 'method');
  if (!method) throw badRequest('Indica la forma de pago', 'MISSING_FIELD');
  const data = await withTenant(req.tenant.id, async (db) => {
    const p = await getPeriod(db, req.tenant.id, req.params.id, { lock: true });
    if (!p) throw notFound('Periodo no encontrado', 'PERIOD_NOT_FOUND');
    if (p.status !== 'aprobada') throw new HttpError(409, 'Solo se pagan nóminas aprobadas', 'INVALID_PERIOD_STATUS');
    const { rowCount } = await db.query(
      `UPDATE payroll_items SET paid_at = now(), paid_method = $3, paid_by = $4, updated_at = now()
        WHERE restaurant_id = $1 AND period_id = $2 AND paid_at IS NULL`,
      [req.tenant.id, p.id, method, req.user.id],
    );
    return { paid: rowCount, ...(await periodDetail(db, req.tenant.id, p.id)) };
  });
  res.json(data);
}));

export default router;
