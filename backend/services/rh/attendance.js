// Lectura de los datos de asistencia de la BD (horarios, checadas,
// justificaciones, festivos) para pasarlos a payrollMath. Reciben un `db`
// que ya viene de withTenant.
import { isModuleActive } from '../billing.js';
import { localParts } from './dates.js';
import { holidaysBetween } from './holidays.js';
import { analyzeAttendance, markOpenShiftsPending } from './payrollMath.js';

export async function getPayrollSettings(db, restaurantId) {
  await db.query('INSERT INTO payroll_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [restaurantId]);
  return (await db.query('SELECT * FROM payroll_settings WHERE restaurant_id = $1', [restaurantId])).rows[0];
}

/** ¿El modulo esta vigente para el restaurante? (para cruzar rh, pos y empleado_mes). */
export async function moduleActive(db, restaurantId, code, now = new Date()) {
  const { rows } = await db.query(
    'SELECT enabled, started_at, ends_at FROM restaurant_modules WHERE restaurant_id = $1 AND module_code = $2',
    [restaurantId, code],
  );
  return isModuleActive(rows[0], now);
}

export const EMPLOYEE_COLUMNS = `e.id, e.user_id, e.branch_id, e.area_id, e.full_name, e.employee_number, e.position,
  e.pay_type, e.daily_salary, e.hourly_rate, e.payment_frequency,
  to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(e.termination_date, 'YYYY-MM-DD') AS termination_date,
  e.active, e.nss, e.rfc, e.curp, e.phone, e.email, e.bank_name, e.bank_account, e.notes,
  (e.pin_hash IS NOT NULL) AS has_pin, e.created_at, e.updated_at,
  b.name AS branch_name, b.timezone, a.name AS area_name, u.name AS user_name, u.email AS user_email, u.role AS user_role`;

export const EMPLOYEE_FROM = `employees e
  JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
  LEFT JOIN hr_areas a ON a.id = e.area_id AND a.restaurant_id = e.restaurant_id
  LEFT JOIN users u ON u.id = e.user_id AND u.restaurant_id = e.restaurant_id`;

/**
 * Empleados que trabajaron (o pudieron trabajar) entre dos fechas: activos o
 * dados de baja dentro del rango, y contratados antes del fin.
 */
export async function employeesInRange(db, restaurantId, from, to, { frequency, branchId, employeeIds } = {}) {
  const params = [restaurantId, from, to];
  let where = `e.restaurant_id = $1 AND e.hire_date <= $3
    AND (e.termination_date IS NULL OR e.termination_date >= $2)
    AND (e.active OR e.termination_date IS NOT NULL)`;
  if (frequency) { params.push(frequency); where += ` AND e.payment_frequency = $${params.length}`; }
  if (branchId) { params.push(branchId); where += ` AND e.branch_id = $${params.length}`; }
  if (employeeIds) { params.push(employeeIds); where += ` AND e.id = ANY($${params.length}::uuid[])`; }
  return (await db.query(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${where} ORDER BY e.full_name, e.id`, params)).rows;
}

/**
 * Asistencia dia por dia de varios empleados. Regresa Map id -> days
 * (analyzeAttendance) y los festivos usados.
 */
export async function attendanceFor(db, restaurantId, employees, from, to, { now = new Date(), settings } = {}) {
  const s = settings || await getPayrollSettings(db, restaurantId);
  const ids = employees.map((e) => e.id);
  const result = new Map();
  if (ids.length === 0) return { days: result, holidays: new Map() };

  const custom = (await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, name FROM hr_holidays
      WHERE restaurant_id = $1 AND date BETWEEN $2 AND $3`,
    [restaurantId, from, to],
  )).rows;
  const holidays = holidaysBetween(from, to, { official: s.official_holidays, custom });

  const schedules = (await db.query(
    `SELECT employee_id, day_of_week, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM employee_schedules WHERE restaurant_id = $1 AND employee_id = ANY($2::uuid[])`,
    [restaurantId, ids],
  )).rows;
  // Un dia antes y dos despues: cubre cualquier zona horaria y turnos nocturnos.
  const entries = (await db.query(
    `SELECT employee_id, kind, occurred_at FROM time_entries
      WHERE restaurant_id = $1 AND employee_id = ANY($2::uuid[]) AND NOT voided
        AND occurred_at >= $3::date - 1 AND occurred_at < $4::date + 2
      ORDER BY occurred_at`,
    [restaurantId, ids, from, to],
  )).rows;
  const justifications = (await db.query(
    `SELECT employee_id, to_char(date, 'YYYY-MM-DD') AS date, kind, with_pay, note FROM attendance_justifications
      WHERE restaurant_id = $1 AND employee_id = ANY($2::uuid[]) AND date BETWEEN $3 AND $4`,
    [restaurantId, ids, from, to],
  )).rows;

  const group = (rows) => {
    const m = new Map(ids.map((id) => [id, []]));
    for (const r of rows) m.get(r.employee_id)?.push(r);
    return m;
  };
  const sch = group(schedules);
  const ent = group(entries);
  const jus = group(justifications);

  for (const e of employees) {
    const tz = e.timezone || 'America/Mexico_City';
    const local = localParts(now, tz);
    const days = analyzeAttendance({
      from, to,
      schedule: sch.get(e.id),
      entries: ent.get(e.id),
      justifications: jus.get(e.id),
      holidays,
      timeZone: tz,
      toleranceMinutes: Number(s.tolerance_minutes),
      hireDate: e.hire_date,
      terminationDate: e.termination_date,
      today: local.date,
    });
    markOpenShiftsPending(days, local.date, local.minutes);
    result.set(e.id, days);
  }
  return { days: result, holidays };
}

/** Resumen para el empleado del mes a partir de los dias analizados. */
export function attendanceSummary(days) {
  const laboral = days.filter((d) => d.type === 'laboral' && ['trabajado', 'falta', 'falta_justificada'].includes(d.status));
  return {
    scheduled: laboral.length,
    present: laboral.filter((d) => d.status !== 'falta').length,
    worked: days.filter((d) => d.worked && d.status === 'trabajado').length,
    tardies: days.filter((d) => d.tardy && !d.tardy_justified).length,
  };
}

