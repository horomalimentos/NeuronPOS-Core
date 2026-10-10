// Prenomina en vivo, aclaraciones del empleado y aguinaldo (modulo rh).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { localToday } from '../../services/rh/dates.js';
import { employeesInRange, getPayrollSettings } from '../../services/rh/attendance.js';
import {
  CLAIM_SELECT, aguinaldoFor, createClaim, livePayroll, resolveClaim,
} from '../../services/rh/extras.js';
import {
  HttpError, ah, badRequest, money, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { getEmployee } from '../employees.js';
import { int } from '../pos/common.js';
import { adminOnly, manager } from './common.js';

const router = Router();

async function myEmployee(db, req) {
  const row = (await db.query('SELECT id FROM employees WHERE restaurant_id = $1 AND user_id = $2', [req.tenant.id, req.user.id])).rows[0];
  if (!row) throw notFound('Tu usuario no está ligado a un empleado. Pide a tu gerente que lo ligue en Recursos humanos.', 'NOT_AN_EMPLOYEE');
  return getEmployee(db, req.tenant.id, row.id);
}

/** Hoy en la zona de la sucursal (la primera, o la elegida). */
async function todayFor(db, req, branchId) {
  const b = (await db.query(
    'SELECT timezone FROM branches WHERE restaurant_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at LIMIT 1',
    [req.tenant.id, branchId ?? null],
  )).rows[0];
  return localToday(b?.timezone || 'America/Mexico_City');
}

// --- Prenomina en vivo ---

router.get('/payroll/live', manager, ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : undefined;
  const data = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req, branchId);
    const employees = (await employeesInRange(db, req.tenant.id, today, today, { branchId })).filter((e) => e.active);
    const items = await livePayroll(db, req.tenant.id, employees, today);
    const pending = (await db.query(
      "SELECT count(*)::int AS n FROM payroll_claims WHERE restaurant_id = $1 AND status = 'pendiente'", [req.tenant.id],
    )).rows[0].n;
    return { today, items, pending_claims: pending };
  });
  res.json(data);
}));

router.get('/me/live', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    const today = localToday(emp.timezone);
    const [item] = await livePayroll(db, req.tenant.id, [emp], today);
    return { today, item };
  });
  res.json(data);
}));

// --- Aclaraciones ---

router.get('/me/claims', ah(async (req, res) => {
  const claims = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    return (await db.query(`${CLAIM_SELECT} WHERE c.restaurant_id = $1 AND c.employee_id = $2 ORDER BY c.created_at DESC LIMIT 100`,
      [req.tenant.id, emp.id])).rows;
  });
  res.json({ claims });
}));

router.post('/me/claims', ah(async (req, res) => {
  const claim = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    const id = await createClaim(db, req.tenant.id, emp, req.body || {}, req.user.id, localToday(emp.timezone));
    return (await db.query(`${CLAIM_SELECT} WHERE c.id = $1 AND c.restaurant_id = $2`, [id, req.tenant.id])).rows[0];
  });
  res.status(201).json({ claim });
}));

router.get('/claims', manager, ah(async (req, res) => {
  const status = oneOf(req.query.status || undefined, ['pendiente', 'resuelta', 'rechazada'], 'status');
  const params = [req.tenant.id];
  let where = 'c.restaurant_id = $1';
  if (status) { params.push(status); where += ` AND c.status = $${params.length}`; }
  if (req.query.employee_id) { params.push(requireUuid(req.query.employee_id, 'employee_id')); where += ` AND c.employee_id = $${params.length}`; }
  const data = await withTenant(req.tenant.id, async (db) => ({
    claims: (await db.query(`${CLAIM_SELECT} WHERE ${where} ORDER BY (c.status = 'pendiente') DESC, c.created_at DESC LIMIT 300`, params)).rows,
    pending_count: (await db.query(
      "SELECT count(*)::int AS n FROM payroll_claims WHERE restaurant_id = $1 AND status = 'pendiente'", [req.tenant.id],
    )).rows[0].n,
  }));
  res.json(data);
}));

router.post('/claims/:id/resolve', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const b = req.body || {};
  const status = oneOf(b.status, ['resuelta', 'rechazada'], 'status');
  if (!status) throw badRequest('Indica si se resolvió o se rechaza', 'MISSING_FIELD');
  const response = str(b.response, { field: 'response', required: true, max: 1000 });
  const claim = await withTenant(req.tenant.id, async (db) => {
    await resolveClaim(db, req.tenant.id, req.params.id, { status, response, userId: req.user.id });
    return (await db.query(`${CLAIM_SELECT} WHERE c.id = $1 AND c.restaurant_id = $2`, [req.params.id, req.tenant.id])).rows[0];
  });
  res.json({ claim });
}));

// --- Aguinaldo ---

function readYear(v, fallback) {
  return int(v ?? String(fallback), { field: 'year', min: 2000, max: 2100 });
}

async function aguinaldoList(db, req, year, { employeeIds } = {}) {
  const s = await getPayrollSettings(db, req.tenant.id);
  const employees = await employeesInRange(db, req.tenant.id, `${year}-01-01`, `${year}-12-31`, { employeeIds });
  const paid = new Map((await db.query(
    `SELECT a.*, u.name AS paid_by_name FROM aguinaldo_payments a
       LEFT JOIN users u ON u.id = a.paid_by AND u.restaurant_id = a.restaurant_id
      WHERE a.restaurant_id = $1 AND a.year = $2`,
    [req.tenant.id, year],
  )).rows.map((p) => [p.employee_id, p]));
  return {
    year,
    aguinaldo_days: s.aguinaldo_days,
    employees: employees.map((e) => ({
      employee_id: e.id, full_name: e.full_name, position: e.position, branch_id: e.branch_id, branch_name: e.branch_name,
      hire_date: e.hire_date, termination_date: e.termination_date, active: e.active,
      ...aguinaldoFor(e, year, Number(s.aguinaldo_days), Number(s.daily_hours)),
      payment: paid.get(e.id) || null,
    })),
  };
}

router.get('/aguinaldo', manager, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const year = readYear(req.query.year, Number((await todayFor(db, req)).slice(0, 4)));
    return aguinaldoList(db, req, year);
  });
  res.json(data);
}));

router.post('/aguinaldo/pay', adminOnly, ah(async (req, res) => {
  const b = req.body || {};
  const employeeId = requireUuid(b.employee_id, 'employee_id');
  const method = oneOf(b.method ?? 'efectivo', ['efectivo', 'transferencia', 'otro'], 'method');
  const notes = str(b.notes, { field: 'notes', max: 300 }) ?? null;
  const data = await withTenant(req.tenant.id, async (db) => {
    const year = readYear(b.year, Number((await todayFor(db, req)).slice(0, 4)));
    const { employees: [row] } = await aguinaldoList(db, req, year, { employeeIds: [employeeId] });
    if (!row) throw notFound('Empleado no encontrado en ese año', 'EMPLOYEE_NOT_FOUND');
    if (row.payment) throw new HttpError(409, 'Ya se registró el aguinaldo de ese año', 'ALREADY_PAID');
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? row.amount : money(b.amount, { field: 'amount' });
    if (!(amount > 0)) throw badRequest('El monto debe ser mayor a cero', 'INVALID_FIELD');
    await db.query(
      `INSERT INTO aguinaldo_payments (restaurant_id, year, employee_id, days_counted, daily_base, aguinaldo_days, calculated,
                                       amount, method, notes, paid_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [req.tenant.id, year, employeeId, row.days_counted, row.daily_base, row.aguinaldo_days, row.amount, amount, method, notes, req.user.id],
    );
    return aguinaldoList(db, req, year, { employeeIds: [employeeId] });
  });
  res.status(201).json({ employee: data.employees[0] });
}));

router.delete('/aguinaldo/:id', adminOnly, ah(async (req, res) => {
  requireUuid(req.params.id);
  const { rowCount } = await withTenant(req.tenant.id, (db) => db.query(
    'DELETE FROM aguinaldo_payments WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id],
  ));
  if (!rowCount) throw notFound('Pago no encontrado', 'PAYMENT_NOT_FOUND');
  res.status(204).end();
}));

router.get('/me/aguinaldo', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    const year = Number(localToday(emp.timezone).slice(0, 4));
    const { employees: [row], aguinaldo_days: days } = await aguinaldoList(db, req, year, { employeeIds: [emp.id] });
    const { payment, ...rest } = row || {};
    return row ? { year, aguinaldo_days: days, ...rest, paid: payment ? { amount: payment.amount, paid_at: payment.paid_at } : null } : null;
  });
  res.json({ aguinaldo: data });
}));

export default router;
