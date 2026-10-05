// Asistencia: reporte dia por dia (retardos, faltas, horas) y
// justificaciones de incidencias.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { attendanceFor, employeesInRange } from '../../services/rh/attendance.js';
import { isDateStr } from '../../services/rh/dates.js';
import {
  ah, badRequest, bool, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { assertDayEditable, manager, readRange } from './common.js';

const router = Router();

/** Resumen de los dias analizados. */
export function summarize(days) {
  const c = (fn) => days.filter(fn).length;
  return {
    days_scheduled: c((d) => d.type === 'laboral' && !['pendiente', 'fuera_de_contrato'].includes(d.status)),
    days_worked: c((d) => d.worked),
    absences: c((d) => d.absence && !d.absence_justified),
    absences_justified: c((d) => d.absence && d.absence_justified),
    tardies: c((d) => d.tardy && !d.tardy_justified),
    tardies_justified: c((d) => d.tardy && d.tardy_justified),
    minutes_worked: days.reduce((s, d) => s + d.minutes_worked, 0),
    incomplete: c((d) => d.incomplete),
  };
}

router.get('/attendance', manager, ah(async (req, res) => {
  const { from, to } = readRange(req.query, { maxDays: 62 });
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : undefined;
  const employeeIds = req.query.employee_id ? [requireUuid(req.query.employee_id, 'employee_id')] : undefined;
  const employees = await withTenant(req.tenant.id, async (db) => {
    const list = await employeesInRange(db, req.tenant.id, from, to, { branchId, employeeIds });
    const { days } = await attendanceFor(db, req.tenant.id, list, from, to);
    return list.map((e) => ({
      employee_id: e.id, full_name: e.full_name, position: e.position, branch_id: e.branch_id, branch_name: e.branch_name,
      summary: summarize(days.get(e.id)),
      days: days.get(e.id),
    }));
  });
  res.json({ from, to, employees });
}));

router.get('/justifications', manager, ah(async (req, res) => {
  const { from, to } = readRange(req.query, { maxDays: 366 });
  const params = [req.tenant.id, from, to];
  let where = 'j.restaurant_id = $1 AND j.date BETWEEN $2 AND $3';
  if (req.query.employee_id) { params.push(requireUuid(req.query.employee_id, 'employee_id')); where += ` AND j.employee_id = $${params.length}`; }
  const justifications = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT j.id, j.employee_id, e.full_name AS employee_name, to_char(j.date, 'YYYY-MM-DD') AS date, j.kind, j.note,
            j.with_pay, j.created_at, u.name AS created_by_name
       FROM attendance_justifications j
       JOIN employees e ON e.id = j.employee_id AND e.restaurant_id = j.restaurant_id
       JOIN users u ON u.id = j.created_by AND u.restaurant_id = j.restaurant_id
      WHERE ${where} ORDER BY j.date DESC`,
    params,
  )).rows);
  res.json({ justifications });
}));

// Justificar un retardo o una falta (si ya existe se actualiza la nota).
router.post('/justifications', manager, ah(async (req, res) => {
  const b = req.body || {};
  const employeeId = requireUuid(b.employee_id, 'employee_id');
  if (!isDateStr(b.date)) throw badRequest('Fecha inválida (AAAA-MM-DD)', 'INVALID_FIELD');
  const kind = oneOf(b.kind, ['retardo', 'falta'], 'kind');
  if (!kind) throw badRequest('Indica si es retardo o falta', 'MISSING_FIELD');
  const note = str(b.note, { field: 'note', required: true, max: 500 });
  const withPay = kind === 'falta' ? (bool(b.with_pay, 'with_pay') ?? false) : false;
  const justification = await withTenant(req.tenant.id, async (db) => {
    const ok = await db.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [employeeId, req.tenant.id]);
    if (!ok.rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
    await assertDayEditable(db, req.tenant.id, employeeId, b.date);
    return (await db.query(
      `INSERT INTO attendance_justifications (restaurant_id, employee_id, date, kind, note, with_pay, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (employee_id, date, kind) DO UPDATE SET note = EXCLUDED.note, with_pay = EXCLUDED.with_pay,
         created_by = EXCLUDED.created_by, created_at = now()
       RETURNING id, employee_id, to_char(date, 'YYYY-MM-DD') AS date, kind, note, with_pay`,
      [req.tenant.id, employeeId, b.date, kind, note, withPay, req.user.id],
    )).rows[0];
  });
  res.status(201).json({ justification });
}));

router.delete('/justifications/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const j = (await db.query(
      `SELECT employee_id, to_char(date, 'YYYY-MM-DD') AS date FROM attendance_justifications WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.tenant.id],
    )).rows[0];
    if (!j) throw notFound('Justificación no encontrada', 'JUSTIFICATION_NOT_FOUND');
    await assertDayEditable(db, req.tenant.id, j.employee_id, j.date);
    await db.query('DELETE FROM attendance_justifications WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
  });
  res.status(204).end();
}));

export default router;
