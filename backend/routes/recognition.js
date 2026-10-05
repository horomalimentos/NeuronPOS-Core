// Modulo empleado del mes: configuracion (pesos y premio), evaluaciones del
// gerente, tareas con puntos, ranking en vivo, cierre del mes, historial y
// el muro. Todas las rutas requieren el modulo 'empleado_mes' (402 si no).
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { localToday } from '../services/rh/dates.js';
import { closeMonth, computeMonth, getRecognitionSettings } from '../services/rh/recognition.js';
import {
  HttpError, ah, badRequest, bool, buildSet, money, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';
import { dateField } from './employees.js';
import { int } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('empleado_mes'));
const manager = requireRole('admin', 'gerente');
const adminOnly = requireRole('admin');

function currentMonth(now = new Date()) {
  const [y, m] = localToday(env.billingTimezone, now).split('-').map(Number);
  return { year: y, month: m };
}

function readMonth(query) {
  const cur = currentMonth();
  return {
    year: int(query.year ?? cur.year, { field: 'year', min: 2000, max: 2100 }),
    month: int(query.month ?? cur.month, { field: 'month', min: 1, max: 12 }),
  };
}

// --- Configuracion ---

router.get('/settings', manager, ah(async (req, res) => {
  res.json({ settings: await withTenant(req.tenant.id, (db) => getRecognitionSettings(db, req.tenant.id)) });
}));

router.put('/settings', adminOnly, ah(async (req, res) => {
  const b = req.body || {};
  const w = (k) => int(b[k], { field: k, min: 0, max: 100 });
  const set = buildSet({
    weight_attendance: w('weight_attendance'),
    weight_punctuality: w('weight_punctuality'),
    weight_sales: w('weight_sales'),
    weight_evaluation: w('weight_evaluation'),
    weight_tasks: w('weight_tasks'),
    min_days_worked: int(b.min_days_worked, { field: 'min_days_worked', min: 0, max: 31 }),
    prize_text: str(b.prize_text, { field: 'prize_text', max: 200 }),
    prize_amount: money(b.prize_amount, { field: 'prize_amount' }),
    prize_to_payroll: bool(b.prize_to_payroll, 'prize_to_payroll'),
    auto_close: bool(b.auto_close, 'auto_close'),
  }, 2);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const settings = await withTenant(req.tenant.id, async (db) => {
    await getRecognitionSettings(db, req.tenant.id);
    return (await db.query(
      `UPDATE recognition_settings SET ${set.sql}, updated_at = now() WHERE restaurant_id = $1 RETURNING *`,
      [req.tenant.id, ...set.values],
    )).rows[0];
  });
  res.json({ settings });
}));

// --- Ranking, cierre e historial ---

// Ranking del mes: el guardado si el mes ya se cerro; si no, en vivo.
async function monthRanking(db, req, year, month, branchId) {
  const closed = (await db.query(
    'SELECT closed_at, prize_text, prize_amount, weights FROM recognition_months WHERE restaurant_id = $1 AND year = $2 AND month = $3',
    [req.tenant.id, year, month],
  )).rows[0];
  if (closed) {
    const params = [req.tenant.id, year, month];
    let where = 'r.restaurant_id = $1 AND r.year = $2 AND r.month = $3';
    if (branchId) { params.push(branchId); where += ` AND r.branch_id = $${params.length}`; }
    const ranking = (await db.query(
      `SELECT r.employee_id, r.employee_name, r.branch_id, b.name AS branch_name, e.position, r.rank, r.score,
              r.components, r.is_winner, r.adjustment_id
         FROM recognition_results r
         JOIN branches b ON b.id = r.branch_id AND b.restaurant_id = r.restaurant_id
         JOIN employees e ON e.id = r.employee_id AND e.restaurant_id = r.restaurant_id
        WHERE ${where} ORDER BY b.name, r.rank`,
      params,
    )).rows.map((r) => ({ ...r, score: Number(r.score) }));
    return { year, month, closed: true, closed_at: closed.closed_at, prize_text: closed.prize_text, prize_amount: closed.prize_amount, weights: closed.weights, ranking };
  }
  const { settings, modules, ranking } = await computeMonth(db, req.tenant.id, year, month, { branchId });
  return { year, month, closed: false, prize_text: settings.prize_text, prize_amount: settings.prize_amount, modules, ranking };
}

router.get('/ranking', manager, ah(async (req, res) => {
  const { year, month } = readMonth(req.query);
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : undefined;
  res.json(await withTenant(req.tenant.id, (db) => monthRanking(db, req, year, month, branchId)));
}));

// Cerrar un mes ya terminado a mano (el job lo hace solo el dia 1).
router.post('/months/:year/:month/close', adminOnly, ah(async (req, res) => {
  const year = int(req.params.year, { field: 'year', min: 2000, max: 2100 });
  const month = int(req.params.month, { field: 'month', min: 1, max: 12 });
  const cur = currentMonth();
  if (year > cur.year || (year === cur.year && month >= cur.month)) {
    throw badRequest('Solo se pueden cerrar meses que ya terminaron', 'MONTH_NOT_FINISHED');
  }
  const data = await withTenant(req.tenant.id, async (db) => {
    const result = await closeMonth(db, req.tenant.id, year, month, { userId: req.user.id });
    if (result.alreadyClosed) throw new HttpError(409, 'Ese mes ya está cerrado', 'MONTH_ALREADY_CLOSED');
    return monthRanking(db, req, year, month);
  });
  res.status(201).json(data);
}));

router.get('/history', manager, ah(async (req, res) => {
  const months = await withTenant(req.tenant.id, async (db) => {
    const rows = (await db.query(
      `SELECT m.year, m.month, m.closed_at, m.prize_text, m.prize_amount, u.name AS closed_by_name
         FROM recognition_months m LEFT JOIN users u ON u.id = m.closed_by AND u.restaurant_id = m.restaurant_id
        WHERE m.restaurant_id = $1 ORDER BY m.year DESC, m.month DESC LIMIT 60`,
      [req.tenant.id],
    )).rows;
    const winners = (await db.query(
      `SELECT r.year, r.month, r.employee_id, r.employee_name, r.branch_id, b.name AS branch_name, r.score, r.adjustment_id
         FROM recognition_results r JOIN branches b ON b.id = r.branch_id AND b.restaurant_id = r.restaurant_id
        WHERE r.restaurant_id = $1 AND r.is_winner ORDER BY b.name`,
      [req.tenant.id],
    )).rows;
    return rows.map((m) => ({ ...m, winners: winners.filter((w) => w.year === m.year && w.month === m.month) }));
  });
  res.json({ months });
}));

// Muro (cualquier rol): ganador del ultimo mes cerrado y ranking en vivo del mes.
router.get('/wall', ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : undefined;
  const data = await withTenant(req.tenant.id, async (db) => {
    const last = (await db.query(
      'SELECT year, month FROM recognition_months WHERE restaurant_id = $1 ORDER BY year DESC, month DESC LIMIT 1',
      [req.tenant.id],
    )).rows[0];
    const lastMonth = last ? await monthRanking(db, req, last.year, last.month, branchId) : null;
    const { year, month } = currentMonth();
    const live = await monthRanking(db, req, year, month, branchId);
    const strip = (r) => ({
      employee_id: r.employee_id, employee_name: r.employee_name, position: r.position, branch_id: r.branch_id,
      branch_name: r.branch_name, rank: r.rank, score: r.score, is_winner: r.is_winner,
    });
    return {
      winners: lastMonth ? lastMonth.ranking.filter((r) => r.is_winner).map(strip) : [],
      winners_month: last || null,
      prize_text: lastMonth?.prize_text || live.prize_text,
      current: { year, month, ranking: live.ranking.filter((r) => r.rank <= 10).map(strip) },
    };
  });
  res.json(data);
}));

// --- Evaluaciones del gerente (0 a 100 por mes; una por evaluador) ---

router.get('/evaluations', manager, ah(async (req, res) => {
  const { year, month } = readMonth(req.query);
  const evaluations = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT v.id, v.employee_id, e.full_name AS employee_name, v.year, v.month, v.score, v.comment,
            v.evaluator_id, u.name AS evaluator_name, v.updated_at
       FROM recognition_evaluations v
       JOIN employees e ON e.id = v.employee_id AND e.restaurant_id = v.restaurant_id
       JOIN users u ON u.id = v.evaluator_id AND u.restaurant_id = v.restaurant_id
      WHERE v.restaurant_id = $1 AND v.year = $2 AND v.month = $3 ORDER BY e.full_name`,
    [req.tenant.id, year, month],
  )).rows);
  res.json({ year, month, evaluations });
}));

async function assertMonthOpen(db, restaurantId, year, month) {
  const closed = await db.query('SELECT 1 FROM recognition_months WHERE restaurant_id = $1 AND year = $2 AND month = $3', [restaurantId, year, month]);
  if (closed.rowCount) throw new HttpError(409, 'Ese mes ya está cerrado', 'MONTH_ALREADY_CLOSED');
}

router.put('/evaluations', manager, ah(async (req, res) => {
  const b = req.body || {};
  const employeeId = requireUuid(b.employee_id, 'employee_id');
  const { year, month } = readMonth(b);
  const score = int(b.score, { field: 'score', min: 0, max: 100 });
  if (score === undefined) throw badRequest('Indica la calificación (0 a 100)', 'MISSING_FIELD');
  const comment = str(b.comment, { field: 'comment', max: 500 }) || null;
  const evaluation = await withTenant(req.tenant.id, async (db) => {
    await assertMonthOpen(db, req.tenant.id, year, month);
    const ok = await db.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [employeeId, req.tenant.id]);
    if (!ok.rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
    return (await db.query(
      `INSERT INTO recognition_evaluations (restaurant_id, employee_id, year, month, score, comment, evaluator_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (employee_id, year, month, evaluator_id) DO UPDATE SET score = EXCLUDED.score,
         comment = EXCLUDED.comment, updated_at = now()
       RETURNING id, employee_id, year, month, score, comment`,
      [req.tenant.id, employeeId, year, month, score, comment, req.user.id],
    )).rows[0];
  });
  res.json({ evaluation });
}));

// --- Tareas con puntos ---

const TASK_SELECT = `
  SELECT t.id, t.employee_id, e.full_name AS employee_name, t.title, t.description, t.points,
         to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.status, t.completed_at, t.created_at,
         uv.name AS verified_by_name
    FROM recognition_tasks t
    JOIN employees e ON e.id = t.employee_id AND e.restaurant_id = t.restaurant_id
    LEFT JOIN users uv ON uv.id = t.verified_by AND uv.restaurant_id = t.restaurant_id`;

router.get('/tasks', manager, ah(async (req, res) => {
  const params = [req.tenant.id];
  let where = 't.restaurant_id = $1';
  const status = oneOf(req.query.status, ['pendiente', 'completada', 'cancelada'], 'status');
  if (status) { params.push(status); where += ` AND t.status = $${params.length}`; }
  const tasks = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${TASK_SELECT} WHERE ${where} ORDER BY t.created_at DESC LIMIT 300`, params,
  )).rows);
  res.json({ tasks });
}));

router.post('/tasks', manager, ah(async (req, res) => {
  const b = req.body || {};
  const employeeId = requireUuid(b.employee_id, 'employee_id');
  const title = str(b.title, { field: 'title', required: true, max: 120 });
  const description = str(b.description, { field: 'description', max: 500 }) || null;
  const points = int(b.points ?? 10, { field: 'points', min: 1, max: 1000 });
  const dueDate = dateField(b.due_date, 'due_date') ?? null;
  const task = await withTenant(req.tenant.id, async (db) => {
    const ok = await db.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [employeeId, req.tenant.id]);
    if (!ok.rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
    const { rows } = await db.query(
      `INSERT INTO recognition_tasks (restaurant_id, employee_id, title, description, points, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.tenant.id, employeeId, title, description, points, dueDate, req.user.id],
    );
    return (await db.query(`${TASK_SELECT} WHERE t.id = $1 AND t.restaurant_id = $2`, [rows[0].id, req.tenant.id])).rows[0];
  });
  res.status(201).json({ task });
}));

// Completar (el gerente verifica) o cancelar una tarea pendiente.
router.post('/tasks/:id/:action', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const action = oneOf(req.params.action, ['complete', 'cancel'], 'action');
  const task = await withTenant(req.tenant.id, async (db) => {
    const { rows } = await db.query(
      `UPDATE recognition_tasks SET status = $3, completed_at = CASE WHEN $3 = 'completada' THEN now() END,
              verified_by = CASE WHEN $3 = 'completada' THEN $4::uuid END
        WHERE id = $1 AND restaurant_id = $2 AND status = 'pendiente' RETURNING id`,
      [req.params.id, req.tenant.id, action === 'complete' ? 'completada' : 'cancelada', req.user.id],
    );
    if (!rows[0]) throw notFound('Tarea pendiente no encontrada', 'TASK_NOT_FOUND');
    return (await db.query(`${TASK_SELECT} WHERE t.id = $1 AND t.restaurant_id = $2`, [req.params.id, req.tenant.id])).rows[0];
  });
  res.json({ task });
}));

export default router;
