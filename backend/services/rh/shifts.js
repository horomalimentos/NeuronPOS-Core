// Turnos y rol semanal (modulo 'turnos'). Un dia asignado en el rol manda
// sobre el horario fijo semanal del empleado; un dia sin asignar usa el fijo.
import { HttpError, badRequest } from '../../utils/http.js';
import { addDays, dayOfWeek, daysBetween, eachDay, isDateStr } from './dates.js';
import { employeesInRange, getPayrollSettings } from './attendance.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_BATCH = 500;

export function readTime(v, field) {
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw badRequest(`"${field}" debe ser una hora HH:MM`, 'INVALID_FIELD');
  return v;
}

export function readDate(v, field = 'date') {
  if (!isDateStr(v)) throw badRequest(`"${field}" debe ser una fecha AAAA-MM-DD`, 'INVALID_FIELD');
  return v;
}

/** Inicio de la semana (segun el dia de inicio de la nomina) que contiene la fecha. */
export function weekStart(dateStr, weekStartDay) {
  return addDays(dateStr, -((dayOfWeek(dateStr) - weekStartDay + 7) % 7));
}

export const TEMPLATE_COLUMNS = `id, name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
  color, active, created_at`;

export async function listTemplates(db, rid) {
  return (await db.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM shift_templates WHERE restaurant_id = $1 ORDER BY active DESC, start_time, name`, [rid],
  )).rows;
}

/**
 * Rol de una semana: por empleado, cada dia con su origen ('rol' = asignado,
 * 'fijo' = su horario semanal, null = sin horario).
 */
export async function weekView(db, rid, start, { branchId, employeeIds } = {}) {
  const end = addDays(start, 6);
  const dates = eachDay(start, end);
  const employees = await employeesInRange(db, rid, start, end, { branchId, employeeIds });
  const ids = employees.map((e) => e.id);
  const fixed = (await db.query(
    `SELECT employee_id, day_of_week, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM employee_schedules WHERE restaurant_id = $1 AND employee_id = ANY($2::uuid[])`,
    [rid, ids],
  )).rows;
  const assigned = (await db.query(
    `SELECT d.employee_id, to_char(d.date, 'YYYY-MM-DD') AS date, d.shift_id, d.is_rest, d.note,
            to_char(d.start_time, 'HH24:MI') AS start_time, to_char(d.end_time, 'HH24:MI') AS end_time,
            t.name AS shift_name, t.color
       FROM employee_shift_days d
       LEFT JOIN shift_templates t ON t.id = d.shift_id AND t.restaurant_id = d.restaurant_id
      WHERE d.restaurant_id = $1 AND d.employee_id = ANY($2::uuid[]) AND d.date BETWEEN $3 AND $4`,
    [rid, ids, start, end],
  )).rows;
  const fixedBy = new Map(fixed.map((f) => [`${f.employee_id}|${f.day_of_week}`, f]));
  const rolBy = new Map(assigned.map((a) => [`${a.employee_id}|${a.date}`, a]));
  return {
    start,
    end,
    dates,
    employees: employees.map((e) => ({
      id: e.id,
      full_name: e.full_name,
      position: e.position,
      area_name: e.area_name,
      branch_id: e.branch_id,
      branch_name: e.branch_name,
      days: dates.map((date) => {
        const outside = date < e.hire_date || (e.termination_date && date > e.termination_date);
        const a = rolBy.get(`${e.id}|${date}`);
        if (a) {
          return {
            date, source: 'rol', shift_id: a.shift_id, shift_name: a.is_rest ? 'Descanso' : a.shift_name, color: a.color,
            is_rest: a.is_rest, start_time: a.start_time, end_time: a.end_time, note: a.note, outside,
          };
        }
        const f = fixedBy.get(`${e.id}|${dayOfWeek(date)}`);
        return {
          date, source: f ? 'fijo' : null, shift_id: null, shift_name: null, color: null,
          is_rest: !f, start_time: f?.start_time ?? null, end_time: f?.end_time ?? null, note: null, outside,
        };
      }),
    })),
  };
}

/** Empleados (del restaurante) con dias en una nomina aprobada o cerrada dentro del rango. */
async function lockedDays(db, rid, employeeIds, from, to) {
  const rows = (await db.query(
    `SELECT i.employee_id, to_char(greatest(p.start_date, $3::date), 'YYYY-MM-DD') AS from_date,
            to_char(least(p.end_date, $4::date), 'YYYY-MM-DD') AS to_date
       FROM payroll_items i
       JOIN payroll_periods p ON p.id = i.period_id AND p.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.employee_id = ANY($2::uuid[]) AND p.status <> 'borrador'
        AND p.start_date <= $4 AND p.end_date >= $3`,
    [rid, employeeIds, from, to],
  )).rows;
  const set = new Set();
  for (const r of rows) for (const d of eachDay(r.from_date, r.to_date)) set.add(`${r.employee_id}|${d}`);
  return set;
}

const lockedError = () => new HttpError(409, 'Hay días en una nómina aprobada o cerrada; reábrela para cambiar el rol', 'PERIOD_LOCKED');

/**
 * Guarda varios dias del rol. Cada item: {employee_id, date} y uno de
 * shift_id (turno del catalogo), start_time+end_time (a mano), rest: true o
 * clear: true (vuelve al horario fijo).
 */
export async function saveDays(db, rid, items, userId) {
  if (!Array.isArray(items) || !items.length) throw badRequest('Manda al menos un día', 'MISSING_FIELD');
  if (items.length > MAX_BATCH) throw badRequest(`Máximo ${MAX_BATCH} días a la vez`, 'TOO_MANY');
  const parsed = items.map((it, i) => {
    if (!it || typeof it !== 'object') throw badRequest(`Día ${i + 1} no válido`, 'INVALID_FIELD');
    const date = readDate(it.date);
    const employeeId = String(it.employee_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(employeeId)) throw badRequest('employee_id inválido', 'INVALID_ID');
    if (it.clear) return { employeeId, date, clear: true };
    if (it.rest) return { employeeId, date, rest: true, note: it.note ? String(it.note).slice(0, 200) : null };
    if (it.shift_id) return { employeeId, date, shiftId: String(it.shift_id), note: it.note ? String(it.note).slice(0, 200) : null };
    const start = readTime(it.start_time, 'start_time');
    const end = readTime(it.end_time, 'end_time');
    if (start === end) throw badRequest('La entrada y la salida no pueden ser iguales', 'INVALID_FIELD');
    return { employeeId, date, start, end, note: it.note ? String(it.note).slice(0, 200) : null };
  });

  const employeeIds = [...new Set(parsed.map((p) => p.employeeId))];
  const found = (await db.query('SELECT id FROM employees WHERE restaurant_id = $1 AND id = ANY($2::uuid[])', [rid, employeeIds])).rows;
  if (found.length !== employeeIds.length) throw badRequest('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
  const shiftIds = [...new Set(parsed.filter((p) => p.shiftId).map((p) => p.shiftId))];
  const templates = new Map((await db.query(
    `SELECT id, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM shift_templates WHERE restaurant_id = $1 AND id::text = ANY($2::text[]) AND active`,
    [rid, shiftIds],
  )).rows.map((t) => [t.id, t]));
  if (templates.size !== shiftIds.length) throw badRequest('Turno no encontrado o inactivo', 'SHIFT_NOT_FOUND');

  const dates = parsed.map((p) => p.date).sort();
  const locked = await lockedDays(db, rid, employeeIds, dates[0], dates[dates.length - 1]);
  if (parsed.some((p) => locked.has(`${p.employeeId}|${p.date}`))) throw lockedError();

  for (const p of parsed) {
    if (p.clear) {
      await db.query('DELETE FROM employee_shift_days WHERE restaurant_id = $1 AND employee_id = $2 AND date = $3', [rid, p.employeeId, p.date]);
      continue;
    }
    const t = p.shiftId ? templates.get(p.shiftId) : null;
    await db.query(
      `INSERT INTO employee_shift_days (restaurant_id, employee_id, date, shift_id, is_rest, start_time, end_time, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (employee_id, date) DO UPDATE
         SET shift_id = EXCLUDED.shift_id, is_rest = EXCLUDED.is_rest, start_time = EXCLUDED.start_time,
             end_time = EXCLUDED.end_time, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [rid, p.employeeId, p.date, p.shiftId || null, Boolean(p.rest),
        p.rest ? null : (t?.start_time ?? p.start), p.rest ? null : (t?.end_time ?? p.end), p.note ?? null, userId],
    );
  }
  return parsed.length;
}

/** Copia el rol de una semana a otra (mismos dias de la semana). */
export async function copyWeek(db, rid, from, to, { branchId, overwrite = false, userId }) {
  if (from === to) throw badRequest('Elige otra semana para copiar', 'INVALID_FIELD');
  const target = await weekView(db, rid, to, { branchId });
  const ids = target.employees.map((e) => e.id);
  if (!ids.length) return 0;
  const locked = await lockedDays(db, rid, ids, to, addDays(to, 6));
  if (locked.size) throw lockedError();
  const offset = daysBetween(from, to);
  const { rowCount } = await db.query(
    `INSERT INTO employee_shift_days (restaurant_id, employee_id, date, shift_id, is_rest, start_time, end_time, note, updated_by, updated_at)
     SELECT d.restaurant_id, d.employee_id, d.date + $5::int, d.shift_id, d.is_rest, d.start_time, d.end_time, d.note, $6, now()
       FROM employee_shift_days d
       JOIN employees e ON e.id = d.employee_id AND e.restaurant_id = d.restaurant_id
      WHERE d.restaurant_id = $1 AND d.employee_id = ANY($2::uuid[]) AND d.date BETWEEN $3 AND $4
        AND d.date + $5::int >= e.hire_date AND (e.termination_date IS NULL OR d.date + $5::int <= e.termination_date)
     ON CONFLICT (employee_id, date) DO ${overwrite ? `UPDATE
       SET shift_id = EXCLUDED.shift_id, is_rest = EXCLUDED.is_rest, start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()` : 'NOTHING'}`,
    [rid, ids, from, addDays(from, 6), offset, userId],
  );
  return rowCount;
}

export async function currentWeekStart(db, rid, today) {
  const s = await getPayrollSettings(db, rid);
  return weekStart(today, Number(s.week_start_day));
}
