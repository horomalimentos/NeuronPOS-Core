// Prenomina en vivo (el periodo en curso, sin guardar), aclaraciones del
// empleado y aguinaldo (LFT art. 87).
import { HttpError, badRequest, notFound } from '../../utils/http.js';
import { fromCents, toCents } from '../posMath.js';
import { daysBetween, isDateStr } from './dates.js';
import { getPayrollSettings } from './attendance.js';
import { computePayroll } from './payroll.js';
import { periodRange } from './payrollMath.js';

// ---------------------------------------------------------------------------
// Prenomina en vivo
// ---------------------------------------------------------------------------

/**
 * Nomina estimada del periodo en curso de cada empleado (segun su
 * frecuencia de pago), con la asistencia hasta hoy. No guarda nada.
 */
export async function livePayroll(db, rid, employees, today, { now = new Date() } = {}) {
  const settings = await getPayrollSettings(db, rid);
  const byFreq = new Map();
  for (const e of employees) {
    if (!byFreq.has(e.payment_frequency)) byFreq.set(e.payment_frequency, []);
    byFreq.get(e.payment_frequency).push(e);
  }
  const out = [];
  for (const [frequency, list] of byFreq) {
    const range = periodRange(frequency, today, Number(settings.week_start_day));
    // Si ya existe el periodo (borrador), sus prestamos no cuentan como ya descontados.
    const period = (await db.query(
      'SELECT id, status FROM payroll_periods WHERE restaurant_id = $1 AND frequency = $2 AND start_date = $3',
      [rid, frequency, range.start],
    )).rows[0];
    const hasPay = (e) => Number(e.pay_type === 'por_hora' ? e.hourly_rate : e.daily_salary) > 0;
    const results = await computePayroll(db, rid, list.filter(hasPay), range, settings, { excludePeriodId: period?.id ?? null, now });
    for (const e of list) {
      const r = results.get(e.id);
      out.push({
        employee_id: e.id, full_name: e.full_name, position: e.position, branch_id: e.branch_id, branch_name: e.branch_name,
        frequency, start_date: range.start, end_date: range.end, period_id: period?.id ?? null, period_status: period?.status ?? null,
        ...(r ? {
          days_worked: r.days_worked, absences: r.absences, tardies: r.tardies, minutes_worked: r.minutes_worked,
          gross: r.gross, deductions: r.deductions, net: r.net, lines: r.lines,
          days: r.days.map((d) => ({
            date: d.date, type: d.type, status: d.status, shift_name: d.shift_name, holiday_name: d.holiday_name,
            scheduled_start: d.scheduled_start, scheduled_end: d.scheduled_end, first_in: d.first_in,
            minutes_worked: d.minutes_worked, late_minutes: d.late_minutes, tardy: d.tardy, overtime_minutes: d.overtime_minutes,
          })),
        } : { no_salary: true }),
      });
    }
  }
  return out.sort((a, b) => a.full_name.localeCompare(b.full_name, 'es'));
}

// ---------------------------------------------------------------------------
// Aclaraciones
// ---------------------------------------------------------------------------

export const CLAIM_KINDS = ['falta', 'retardo', 'horas', 'pago', 'descuento', 'otro'];

export const CLAIM_SELECT = `
  SELECT c.id, c.employee_id, e.full_name AS employee_name, e.branch_id, c.item_id, to_char(c.date, 'YYYY-MM-DD') AS date,
         c.kind, c.description, c.amount, c.status, c.response, c.resolved_at, c.created_at, u.name AS resolved_by_name,
         to_char(p.start_date, 'YYYY-MM-DD') AS period_start, to_char(p.end_date, 'YYYY-MM-DD') AS period_end, p.id AS period_id
    FROM payroll_claims c
    JOIN employees e ON e.id = c.employee_id AND e.restaurant_id = c.restaurant_id
    LEFT JOIN users u ON u.id = c.resolved_by AND u.restaurant_id = c.restaurant_id
    LEFT JOIN payroll_items i ON i.id = c.item_id AND i.restaurant_id = c.restaurant_id
    LEFT JOIN payroll_periods p ON p.id = i.period_id AND p.restaurant_id = i.restaurant_id`;

/** Crea la aclaracion del empleado (sobre un recibo sin firmar o un dia). */
export async function createClaim(db, rid, employee, body, userId, today) {
  const kind = String(body.kind || '');
  if (!CLAIM_KINDS.includes(kind)) throw badRequest('Elige de qué es la aclaración', 'INVALID_FIELD');
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 10) throw badRequest('Explica la aclaración (al menos 10 caracteres)', 'INVALID_FIELD');
  if (description.length > 1000) throw badRequest('La explicación es demasiado larga', 'INVALID_FIELD');
  let amount = null;
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) throw badRequest('Monto no válido', 'INVALID_FIELD');
    amount = Math.round(amount * 100) / 100;
  }
  let itemId = null;
  let date = null;
  if (body.item_id) {
    const item = (await db.query(
      `SELECT i.id, p.status, s.signed_at FROM payroll_items i
         JOIN payroll_periods p ON p.id = i.period_id AND p.restaurant_id = i.restaurant_id
         LEFT JOIN payroll_receipt_signatures s ON s.item_id = i.id AND s.restaurant_id = i.restaurant_id
        WHERE i.id = $1 AND i.restaurant_id = $2 AND i.employee_id = $3`,
      [String(body.item_id), rid, employee.id],
    )).rows[0];
    if (!item || item.status === 'borrador') throw notFound('Recibo no encontrado', 'ITEM_NOT_FOUND');
    if (item.signed_at) throw new HttpError(409, 'Ese recibo ya está firmado', 'ALREADY_SIGNED');
    itemId = item.id;
  }
  if (body.date) {
    if (!isDateStr(body.date)) throw badRequest('Fecha no válida', 'INVALID_FIELD');
    if (body.date > today || daysBetween(body.date, today) > 62) {
      throw badRequest('La fecha debe ser de los últimos 2 meses', 'INVALID_FIELD');
    }
    date = body.date;
  }
  if (!itemId && !date) throw badRequest('Indica el día o el recibo', 'MISSING_FIELD');
  const { rows } = await db.query(
    `INSERT INTO payroll_claims (restaurant_id, employee_id, item_id, date, kind, description, amount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [rid, employee.id, itemId, date, kind, description, amount, userId],
  );
  return rows[0].id;
}

export async function resolveClaim(db, rid, id, { status, response, userId }) {
  const c = (await db.query('SELECT status FROM payroll_claims WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, rid])).rows[0];
  if (!c) throw notFound('Aclaración no encontrada', 'CLAIM_NOT_FOUND');
  if (c.status !== 'pendiente') throw new HttpError(409, 'Esta aclaración ya fue respondida', 'ALREADY_RESOLVED');
  await db.query(
    `UPDATE payroll_claims SET status = $3, response = $4, resolved_by = $5, resolved_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [id, rid, status, response, userId],
  );
}

/** ¿Tiene el recibo una aclaracion sin responder? (no se firma hasta que se responda). */
export async function hasPendingClaim(db, rid, itemId) {
  return (await db.query(
    "SELECT 1 FROM payroll_claims WHERE restaurant_id = $1 AND item_id = $2 AND status = 'pendiente' LIMIT 1", [rid, itemId],
  )).rowCount > 0;
}

// ---------------------------------------------------------------------------
// Aguinaldo
// ---------------------------------------------------------------------------

/**
 * Aguinaldo de un empleado en un año: dias de salario (minimo 15) por los
 * dias trabajados del año entre 365. Salario por hora: tarifa x horas de la
 * jornada. Funcion pura.
 */
export function aguinaldoFor(e, year, aguinaldoDays, dailyHours) {
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  const from = e.hire_date > first ? e.hire_date : first;
  const to = e.termination_date && e.termination_date < last ? e.termination_date : last;
  const days = to < from ? 0 : daysBetween(from, to) + 1;
  const base = e.pay_type === 'por_hora' ? Number(e.hourly_rate) * Number(dailyHours) : Number(e.daily_salary);
  const daysCounted = Math.min(days, 365);
  const amount = fromCents(Math.round(toCents(base) * aguinaldoDays * daysCounted / 365));
  return {
    days_counted: daysCounted,
    proportional: daysCounted < 365,
    daily_base: fromCents(toCents(base)),
    aguinaldo_days: aguinaldoDays,
    amount,
  };
}
