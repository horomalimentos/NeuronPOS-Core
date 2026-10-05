// Empleado del mes: junta los datos del mes (asistencia de rh, ventas del
// POS, evaluaciones y tareas), calcula el ranking con recognitionMath y
// cierra el mes (ganador por sucursal, premio y bono opcional en nomina).
import { env } from '../../config/env.js';
import { withPlatform, withTenant } from '../../config/database.js';
import { isModuleActive } from '../billing.js';
import { attendanceFor, attendanceSummary, employeesInRange, moduleActive } from './attendance.js';
import { addDays, localToday, monthRange } from './dates.js';
import { computeRanking } from './recognitionMath.js';

export async function getRecognitionSettings(db, restaurantId) {
  await db.query('INSERT INTO recognition_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [restaurantId]);
  return (await db.query('SELECT * FROM recognition_settings WHERE restaurant_id = $1', [restaurantId])).rows[0];
}

export const weightsOf = (s) => ({
  attendance: s.weight_attendance,
  punctuality: s.weight_punctuality,
  sales: s.weight_sales,
  evaluation: s.weight_evaluation,
  tasks: s.weight_tasks,
});

/** Ranking del mes calculado en vivo (no guarda nada). */
export async function computeMonth(db, restaurantId, year, month, { now = new Date(), branchId } = {}) {
  const settings = await getRecognitionSettings(db, restaurantId);
  const { start, end } = monthRange(year, month);
  const [hasRh, hasPos] = [await moduleActive(db, restaurantId, 'rh', now), await moduleActive(db, restaurantId, 'pos', now)];
  const employees = await employeesInRange(db, restaurantId, start, end, { branchId });
  const ids = employees.map((e) => e.id);

  let attendance = null;
  if (hasRh && ids.length) {
    const { days } = await attendanceFor(db, restaurantId, employees, start, end, { now });
    attendance = new Map([...days].map(([id, d]) => [id, attendanceSummary(d)]));
  }

  let sales = null;
  if (hasPos && ids.length) {
    sales = new Map((await db.query(
      `SELECT e.id, sum(o.total) AS total
         FROM employees e
         JOIN orders o ON o.created_by = e.user_id AND o.restaurant_id = e.restaurant_id
         JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
        WHERE e.restaurant_id = $1 AND e.id = ANY($2::uuid[]) AND o.status = 'pagada'
          AND (coalesce(o.paid_at, o.created_at) AT TIME ZONE b.timezone) >= $3::date
          AND (coalesce(o.paid_at, o.created_at) AT TIME ZONE b.timezone) < $4::date + 1
        GROUP BY e.id`,
      [restaurantId, ids, start, end],
    )).rows.map((r) => [r.id, Math.round(Number(r.total) * 100)]));
  }

  const evaluations = new Map((await db.query(
    `SELECT employee_id, avg(score) AS avg FROM recognition_evaluations
      WHERE restaurant_id = $1 AND year = $2 AND month = $3 GROUP BY employee_id`,
    [restaurantId, year, month],
  )).rows.map((r) => [r.employee_id, Math.round(Number(r.avg) * 100) / 100]));

  const tasks = new Map((await db.query(
    `SELECT t.employee_id, sum(t.points) AS points
       FROM recognition_tasks t
       JOIN employees e ON e.id = t.employee_id AND e.restaurant_id = t.restaurant_id
       JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
      WHERE t.restaurant_id = $1 AND t.status = 'completada'
        AND (t.completed_at AT TIME ZONE b.timezone) >= $2::date
        AND (t.completed_at AT TIME ZONE b.timezone) < $3::date + 1
      GROUP BY t.employee_id`,
    [restaurantId, start, end],
  )).rows.map((r) => [r.employee_id, Number(r.points)]));

  const ranking = computeRanking({
    employees: employees.map((e) => ({ id: e.id, full_name: e.full_name, branch_id: e.branch_id, user_role: e.user_role })),
    data: { attendance, sales, evaluations, tasks },
    weights: weightsOf(settings),
    minDaysWorked: settings.min_days_worked,
  });
  const branchNames = new Map(employees.map((e) => [e.branch_id, e.branch_name]));
  const extra = new Map(employees.map((e) => [e.id, { position: e.position }]));
  for (const r of ranking) {
    r.branch_name = branchNames.get(r.branch_id);
    r.position = extra.get(r.employee_id)?.position || null;
    r.sales = sales ? (sales.get(r.employee_id) || 0) / 100 : null;
    r.task_points = tasks.get(r.employee_id) || 0;
  }
  return { settings, modules: { rh: hasRh, pos: hasPos }, ranking };
}

/** Mes anterior al de la fecha dada ('YYYY-MM-DD'). */
export function previousMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/**
 * Cierra el mes: guarda el ranking y los ganadores por sucursal. Idempotente
 * (la llave de recognition_months): si ya estaba cerrado regresa
 * { alreadyClosed: true } sin tocar nada.
 */
export async function closeMonth(db, restaurantId, year, month, { userId = null, now = new Date() } = {}) {
  const { settings, modules, ranking } = await computeMonth(db, restaurantId, year, month, { now });
  const inserted = await db.query(
    `INSERT INTO recognition_months (restaurant_id, year, month, weights, prize_text, prize_amount, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING RETURNING year`,
    [restaurantId, year, month, JSON.stringify({ ...weightsOf(settings), min_days_worked: settings.min_days_worked }),
      settings.prize_text, settings.prize_amount, userId],
  );
  if (!inserted.rowCount) return { alreadyClosed: true, winners: [] };

  const prizeToPayroll = settings.prize_to_payroll && modules.rh && Number(settings.prize_amount) > 0;
  const nextMonthStart = addDays(monthRange(year, month).end, 1);
  const winners = [];
  for (const r of ranking) {
    let adjustmentId = null;
    if (r.is_winner && prizeToPayroll) {
      adjustmentId = (await db.query(
        `INSERT INTO payroll_adjustments (restaurant_id, employee_id, kind, concept, amount, recurrence, apply_date, source, created_by)
         VALUES ($1, $2, 'bono', $3, $4, 'unico', $5, 'empleado_mes', $6) RETURNING id`,
        [restaurantId, r.employee_id, `Empleado del mes ${String(month).padStart(2, '0')}/${year}`,
          settings.prize_amount, nextMonthStart, userId],
      )).rows[0].id;
    }
    await db.query(
      `INSERT INTO recognition_results (restaurant_id, year, month, branch_id, employee_id, employee_name, rank, score,
                                        components, is_winner, adjustment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [restaurantId, year, month, r.branch_id, r.employee_id, r.employee_name, r.rank, r.score,
        JSON.stringify({ ...r.components, days_worked: r.days_worked, sales: r.sales, task_points: r.task_points }),
        r.is_winner, adjustmentId],
    );
    if (r.is_winner) winners.push({ ...r, adjustment_id: adjustmentId });
  }
  return { alreadyClosed: false, winners };
}

/**
 * Job (cada hora): a partir del dia 1 cierra el mes anterior de cada
 * restaurante con el modulo vigente y cierre automatico. Si ya estaba
 * cerrado no hace nada.
 */
export async function runRecognitionCycle(now = new Date()) {
  const restaurants = await withPlatform(async (db) => (await db.query(
    `SELECT r.id, rm.enabled, rm.started_at, rm.ends_at
       FROM restaurants r
       JOIN restaurant_modules rm ON rm.restaurant_id = r.id AND rm.module_code = 'empleado_mes'
      WHERE r.status <> 'suspended' AND rm.enabled`,
  )).rows.filter((r) => isModuleActive(r, now)));
  const { year, month } = previousMonth(localToday(env.billingTimezone, now));
  const closed = [];
  for (const r of restaurants) {
    try {
      const res = await withTenant(r.id, async (db) => {
        const s = await getRecognitionSettings(db, r.id);
        if (!s.auto_close) return null;
        return closeMonth(db, r.id, year, month, { now });
      });
      if (res && !res.alreadyClosed) closed.push({ restaurant_id: r.id, year, month, winners: res.winners.length });
    } catch (err) {
      console.error(`[empleado-del-mes] restaurante ${r.id}:`, err.message);
    }
  }
  return closed;
}
