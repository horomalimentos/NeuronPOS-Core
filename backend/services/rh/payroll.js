// Prenomina: calcula (o recalcula) todos los recibos de un periodo. Es
// idempotente: recalcular reemplaza los recibos y sus lineas, nunca duplica.
// Solo se recalcula en borrador; aprobada y cerrada quedan fijas.
import { toCents, fromCents } from '../posMath.js';
import { HttpError } from '../../utils/http.js';
import { attendanceFor, employeesInRange, getPayrollSettings } from './attendance.js';
import { applicableAdjustments, calculatePayroll } from './payrollMath.js';

export const PERIOD_COLUMNS = `p.id, p.frequency, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(p.end_date, 'YYYY-MM-DD') AS end_date, p.status, p.employees_count, p.total_gross, p.total_deductions,
  p.total_net, p.calculated_at, p.approved_at, p.closed_at, p.notes, p.created_at,
  uc.name AS calculated_by_name, ua.name AS approved_by_name, ux.name AS closed_by_name`;

export const PERIOD_FROM = `payroll_periods p
  LEFT JOIN users uc ON uc.id = p.calculated_by AND uc.restaurant_id = p.restaurant_id
  LEFT JOIN users ua ON ua.id = p.approved_by AND ua.restaurant_id = p.restaurant_id
  LEFT JOIN users ux ON ux.id = p.closed_by AND ux.restaurant_id = p.restaurant_id`;

export async function getPeriod(db, restaurantId, id, { lock = false } = {}) {
  if (lock) await db.query('SELECT 1 FROM payroll_periods WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, restaurantId]);
  const { rows } = await db.query(`SELECT ${PERIOD_COLUMNS} FROM ${PERIOD_FROM} WHERE p.id = $1 AND p.restaurant_id = $2`, [id, restaurantId]);
  return rows[0] || null;
}

/** Calcula todos los recibos del periodo. Regresa { calculated, skipped }. */
export async function calculatePeriod(db, restaurantId, periodId, { userId, now = new Date() } = {}) {
  const period = await getPeriod(db, restaurantId, periodId, { lock: true });
  if (!period) throw new HttpError(404, 'Periodo no encontrado', 'PERIOD_NOT_FOUND');
  if (period.status !== 'borrador') {
    throw new HttpError(409, 'Solo se puede recalcular un periodo en borrador', 'PERIOD_LOCKED');
  }
  const settings = await getPayrollSettings(db, restaurantId);
  const range = { start: period.start_date, end: period.end_date };
  const all = await employeesInRange(db, restaurantId, range.start, range.end, { frequency: period.frequency });
  const hasPay = (e) => Number(e.pay_type === 'por_hora' ? e.hourly_rate : e.daily_salary) > 0;
  const employees = all.filter(hasPay);
  const skipped = all.filter((e) => !hasPay(e))
    .map((e) => ({ employee_id: e.id, full_name: e.full_name, reason: 'Sin salario configurado' }));
  const ids = employees.map((e) => e.id);
  const { days: daysByEmployee } = await attendanceFor(db, restaurantId, employees, range.start, range.end, { now, settings });

  const adjustments = (await db.query(
    `SELECT id, employee_id, kind, concept, amount, recurrence, to_char(apply_date, 'YYYY-MM-DD') AS apply_date,
            to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
            total_amount, active
       FROM payroll_adjustments
      WHERE restaurant_id = $1 AND employee_id = ANY($2::uuid[]) AND active
      ORDER BY created_at, id`,
    [restaurantId, ids],
  )).rows;
  // Lo ya descontado de cada prestamo en OTROS periodos.
  const applied = new Map((await db.query(
    `SELECT l.adjustment_id, sum(l.amount) AS total
       FROM payroll_item_lines l
       JOIN payroll_items i ON i.id = l.item_id AND i.restaurant_id = l.restaurant_id
      WHERE l.restaurant_id = $1 AND l.adjustment_id IS NOT NULL AND i.period_id <> $2
      GROUP BY l.adjustment_id`,
    [restaurantId, periodId],
  )).rows.map((r) => [r.adjustment_id, toCents(r.total)]));

  // Los que ya no aplican (baja, cambio de frecuencia) salen del periodo.
  await db.query(
    'DELETE FROM payroll_items WHERE restaurant_id = $1 AND period_id = $2 AND NOT (employee_id = ANY($3::uuid[]))',
    [restaurantId, periodId, ids],
  );

  let gross = 0;
  let deductions = 0;
  let net = 0;
  for (const e of employees) {
    const r = calculatePayroll({
      employee: e,
      settings,
      days: daysByEmployee.get(e.id),
      adjustments: applicableAdjustments(adjustments.filter((a) => a.employee_id === e.id), range, applied),
      weekStartDay: Number(settings.week_start_day),
    });
    const detail = r.days.map((d) => ({
      date: d.date, dow: d.dow, type: d.type, status: d.status, holiday_name: d.holiday_name, shift_name: d.shift_name,
      scheduled_start: d.scheduled_start, scheduled_end: d.scheduled_end, first_in: d.first_in,
      minutes_worked: d.minutes_worked, late_minutes: d.late_minutes, tardy: d.tardy, tardy_justified: d.tardy_justified,
      overtime_minutes: d.overtime_minutes, incomplete: d.incomplete, note: d.note,
    }));
    const { rows } = await db.query(
      `INSERT INTO payroll_items (
         restaurant_id, period_id, employee_id, branch_id, employee_name, position, pay_type, daily_salary, hourly_rate,
         days_scheduled, days_worked, days_paid, rest_days_paid, holidays, holidays_worked, absences, absences_justified,
         tardies, tardy_minutes, minutes_worked, overtime_minutes_double, overtime_minutes_triple,
         gross, deductions, net, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (period_id, employee_id) DO UPDATE SET
         branch_id = EXCLUDED.branch_id, employee_name = EXCLUDED.employee_name, position = EXCLUDED.position,
         pay_type = EXCLUDED.pay_type, daily_salary = EXCLUDED.daily_salary, hourly_rate = EXCLUDED.hourly_rate,
         days_scheduled = EXCLUDED.days_scheduled, days_worked = EXCLUDED.days_worked, days_paid = EXCLUDED.days_paid,
         rest_days_paid = EXCLUDED.rest_days_paid, holidays = EXCLUDED.holidays, holidays_worked = EXCLUDED.holidays_worked,
         absences = EXCLUDED.absences, absences_justified = EXCLUDED.absences_justified, tardies = EXCLUDED.tardies,
         tardy_minutes = EXCLUDED.tardy_minutes, minutes_worked = EXCLUDED.minutes_worked,
         overtime_minutes_double = EXCLUDED.overtime_minutes_double, overtime_minutes_triple = EXCLUDED.overtime_minutes_triple,
         gross = EXCLUDED.gross, deductions = EXCLUDED.deductions, net = EXCLUDED.net, detail = EXCLUDED.detail,
         updated_at = now()
       RETURNING id`,
      [restaurantId, periodId, e.id, e.branch_id, e.full_name, e.position, e.pay_type, e.daily_salary, e.hourly_rate,
        r.days_scheduled, r.days_worked, r.days_paid, r.rest_days_paid, r.holidays, r.holidays_worked, r.absences,
        r.absences_justified, r.tardies, r.tardy_minutes, r.minutes_worked, r.overtime_minutes_double,
        r.overtime_minutes_triple, r.gross, r.deductions, r.net, JSON.stringify(detail)],
    );
    const itemId = rows[0].id;
    await db.query('DELETE FROM payroll_item_lines WHERE restaurant_id = $1 AND item_id = $2', [restaurantId, itemId]);
    for (const [i, l] of r.lines.entries()) {
      await db.query(
        `INSERT INTO payroll_item_lines (restaurant_id, item_id, kind, code, concept, amount, adjustment_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [restaurantId, itemId, l.kind, l.code, l.concept, l.amount, l.adjustment_id, i],
      );
    }
    gross += toCents(r.gross);
    deductions += toCents(r.deductions);
    net += toCents(r.net);
  }

  await db.query(
    `UPDATE payroll_periods SET employees_count = $3, total_gross = $4, total_deductions = $5, total_net = $6,
            calculated_at = now(), calculated_by = $7
      WHERE id = $1 AND restaurant_id = $2`,
    [periodId, restaurantId, employees.length, fromCents(gross), fromCents(deductions), fromCents(net), userId || null],
  );
  return { calculated: employees.length, skipped };
}

export const ITEM_COLUMNS = `i.id, i.period_id, i.employee_id, i.branch_id, b.name AS branch_name, i.employee_name, i.position,
  i.pay_type, i.daily_salary, i.hourly_rate, i.days_scheduled, i.days_worked, i.days_paid, i.rest_days_paid,
  i.holidays, i.holidays_worked, i.absences, i.absences_justified, i.tardies, i.tardy_minutes, i.minutes_worked,
  i.overtime_minutes_double, i.overtime_minutes_triple, i.gross, i.deductions, i.net,
  i.paid_at, i.paid_method, i.cash_movement_id, up.name AS paid_by_name,
  s.signed_at, s.net_at_signing`;

export const ITEM_FROM = `payroll_items i
  JOIN branches b ON b.id = i.branch_id AND b.restaurant_id = i.restaurant_id
  LEFT JOIN users up ON up.id = i.paid_by AND up.restaurant_id = i.restaurant_id
  LEFT JOIN payroll_receipt_signatures s ON s.item_id = i.id AND s.restaurant_id = i.restaurant_id`;

export async function itemLines(db, restaurantId, itemIds) {
  const rows = (await db.query(
    `SELECT item_id, kind, code, concept, amount, adjustment_id FROM payroll_item_lines
      WHERE restaurant_id = $1 AND item_id = ANY($2::uuid[]) ORDER BY sort_order`,
    [restaurantId, itemIds],
  )).rows;
  const m = new Map(itemIds.map((id) => [id, []]));
  for (const r of rows) m.get(r.item_id).push(r);
  return m;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Reporte CSV del periodo (una fila por empleado). */
export function periodCsv(period, items) {
  const header = [
    'Empleado', 'Puesto', 'Sucursal', 'Tipo de pago', 'Salario diario', 'Tarifa por hora', 'Días laborales',
    'Días trabajados', 'Días pagados', 'Festivos', 'Festivos trabajados', 'Faltas', 'Faltas justificadas',
    'Retardos', 'Minutos de retardo', 'Horas trabajadas', 'Horas extra dobles', 'Horas extra triples',
    'Percepciones', 'Deducciones', 'Neto', 'Pagado', 'Forma de pago', 'Firmado',
  ];
  const rows = items.map((i) => [
    i.employee_name, i.position, i.branch_name, i.pay_type === 'por_hora' ? 'Por hora' : 'Diario', i.daily_salary,
    i.hourly_rate, i.days_scheduled, i.days_worked, i.days_paid, i.holidays, i.holidays_worked, i.absences,
    i.absences_justified, i.tardies, i.tardy_minutes, (i.minutes_worked / 60).toFixed(2),
    (i.overtime_minutes_double / 60).toFixed(2), (i.overtime_minutes_triple / 60).toFixed(2),
    i.gross, i.deductions, i.net, i.paid_at ? 'Sí' : 'No', i.paid_method || '', i.signed_at ? 'Sí' : 'No',
  ]);
  const total = ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    period.total_gross, period.total_deductions, period.total_net, '', '', ''];
  const title = [`Nómina ${period.frequency} del ${period.start_date} al ${period.end_date}`];
  // BOM para que Excel abra los acentos bien.
  return `﻿${[title, header, ...rows, total].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
