// Apartados de dinero y metas de aguinaldo (modulo "apartados"), como
// "Fianzas Sanas" de Horom: metas con plan de cuotas, depositos y retiros,
// y apartados compartidos con otros usuarios.
//
// Acceso: los apartados del negocio los manejan admin y gerente; los
// personales, su dueno. Compartido: can_edit registra movimientos y cuotas;
// sin can_edit solo consulta.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { employeesInRange, getPayrollSettings, moduleActive } from '../services/rh/attendance.js';
import { isDateStr, localToday } from '../services/rh/dates.js';
import { aguinaldoFor } from '../services/rh/extras.js';
import { fromCents, toCents } from '../services/posMath.js';
import {
  FREQUENCIES, aguinaldoDueDate, balanceOf, daysLeft, planInstallments,
} from '../services/savings.js';
import {
  COLOR_RE, HttpError, ah, badRequest, bool, forbidden, money, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';
import { canAccessBranch, int, isManager } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('apartados'));

const GOAL_COLS = `g.id, g.kind, g.scope, g.branch_id, b.name AS branch_name, g.owner_id, u.name AS owner_name,
  g.name, g.description, g.color, g.target_amount, g.frequency, g.weekdays,
  to_char(g.start_date, 'YYYY-MM-DD') AS start_date, to_char(g.due_date, 'YYYY-MM-DD') AS due_date,
  g.aguinaldo_year, g.status, g.created_at, g.updated_at,
  coalesce((SELECT sum(CASE WHEN m.kind = 'retiro' THEN -m.amount ELSE m.amount END) FROM savings_movements m WHERE m.goal_id = g.id), 0) AS balance,
  (SELECT count(*)::int FROM savings_installments i WHERE i.goal_id = g.id) AS installments_total,
  (SELECT count(*)::int FROM savings_installments i WHERE i.goal_id = g.id AND i.movement_id IS NOT NULL) AS installments_done,
  (SELECT json_build_object('id', i.id, 'due_on', to_char(i.due_on, 'YYYY-MM-DD'), 'amount', i.amount)
     FROM savings_installments i WHERE i.goal_id = g.id AND i.movement_id IS NULL ORDER BY i.due_on LIMIT 1) AS next_installment,
  s.can_edit AS shared_can_edit`;
const GOAL_FROM = `savings_goals g
  JOIN users u ON u.id = g.owner_id AND u.restaurant_id = g.restaurant_id
  LEFT JOIN branches b ON b.id = g.branch_id AND b.restaurant_id = g.restaurant_id
  LEFT JOIN savings_shares s ON s.goal_id = g.id AND s.user_id = $2`;
// Lo que el usuario puede ver: negocio (si es gerente), lo suyo y lo compartido.
const VISIBLE = `((g.scope = 'negocio' AND $3::boolean) OR g.owner_id = $2 OR s.user_id IS NOT NULL)`;

/** Nivel de acceso: 'manage' (todo), 'edit' (movimientos y cuotas) o 'view'. */
function accessOf(goal, user) {
  if (goal.scope === 'negocio' ? isManager(user) : goal.owner_id === user.id) return 'manage';
  return goal.shared_can_edit ? 'edit' : 'view';
}

function shape(goal, user, today) {
  const { shared_can_edit: _s, ...g } = goal;
  const balance = Number(g.balance);
  const target = Number(g.target_amount);
  return {
    ...g,
    balance,
    target_amount: target,
    missing: Math.max(0, fromCents(toCents(target) - toCents(balance))),
    progress: target > 0 ? Math.min(1, Math.max(0, balance / target)) : 0,
    days_left: g.due_date ? daysLeft(today, g.due_date) : null,
    access: accessOf(goal, user),
  };
}

async function todayFor(db, req) {
  const b = (await db.query(
    'SELECT timezone FROM branches WHERE restaurant_id = $1 ORDER BY created_at LIMIT 1', [req.tenant.id],
  )).rows[0];
  return localToday(b?.timezone || 'America/Mexico_City');
}

async function loadGoal(db, req, id, need = 'view') {
  requireUuid(id);
  const goal = (await db.query(
    `SELECT ${GOAL_COLS} FROM ${GOAL_FROM} WHERE g.restaurant_id = $1 AND g.id = $4 AND ${VISIBLE}`,
    [req.tenant.id, req.user.id, isManager(req.user), id],
  )).rows[0];
  if (!goal) throw notFound('Apartado no encontrado', 'GOAL_NOT_FOUND');
  const access = accessOf(goal, req.user);
  if (need === 'manage' && access !== 'manage') throw forbidden('Solo quien administra el apartado puede hacer esto', 'GOAL_FORBIDDEN');
  if (need === 'edit' && access === 'view') throw forbidden('Este apartado lo tienes solo para consultar', 'GOAL_READ_ONLY');
  return goal;
}

function readDate(v, field, { required = false } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '') {
    if (required) throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
    return null;
  }
  if (!isDateStr(String(v))) throw badRequest(`${field} debe tener formato AAAA-MM-DD`, 'INVALID_FIELD');
  return String(v);
}

function readWeekdays(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.length || v.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw badRequest('weekdays debe ser una lista de dias 1 (lunes) a 7 (domingo)', 'INVALID_FIELD');
  }
  return [...new Set(v)].sort();
}

/** Campos del apartado (plan incluido). */
function goalFields(b, creating) {
  const f = {
    name: str(b.name, { field: 'name', required: creating, max: 80 }),
    description: str(b.description, { field: 'description', max: 500 }),
    color: b.color === undefined ? undefined : String(b.color),
    target_amount: b.target_amount === undefined ? undefined : money(b.target_amount, { field: 'target_amount' }),
    frequency: b.frequency === undefined ? undefined : (b.frequency ? oneOf(b.frequency, FREQUENCIES, 'frequency') : null),
    weekdays: readWeekdays(b.weekdays),
    start_date: readDate(b.start_date, 'start_date'),
    due_date: readDate(b.due_date, 'due_date'),
  };
  if (f.color !== undefined && !COLOR_RE.test(f.color)) throw badRequest('El color debe ser #RRGGBB', 'INVALID_FIELD');
  if (f.target_amount !== undefined && !(f.target_amount > 0)) throw badRequest('La meta debe ser mayor a cero', 'INVALID_FIELD');
  return f;
}

function checkPlan(g) {
  if (g.frequency && !g.due_date) throw badRequest('Para repartir en cuotas indica la fecha límite', 'MISSING_FIELD');
  if (g.due_date && g.due_date < g.start_date) throw badRequest('La fecha límite es antes del inicio', 'INVALID_FIELD');
}

/**
 * Rehace las cuotas pendientes: lo que falta para la meta se reparte desde
 * hoy (o el inicio, si es despues) hasta la fecha limite. Las ya apartadas se
 * conservan.
 */
async function replan(db, rid, goalId, today) {
  await db.query('DELETE FROM savings_installments WHERE restaurant_id = $1 AND goal_id = $2 AND movement_id IS NULL', [rid, goalId]);
  const g = (await db.query(
    `SELECT target_amount, frequency, weekdays, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(due_date, 'YYYY-MM-DD') AS due_date, status FROM savings_goals WHERE restaurant_id = $1 AND id = $2`,
    [rid, goalId],
  )).rows[0];
  if (!g.frequency || g.status !== 'activo') return;
  const movements = (await db.query('SELECT kind, amount FROM savings_movements WHERE restaurant_id = $1 AND goal_id = $2', [rid, goalId])).rows;
  const remaining = fromCents(toCents(g.target_amount) - toCents(balanceOf(movements)));
  let plan;
  try {
    plan = planInstallments({
      remaining, frequency: g.frequency, weekdays: g.weekdays, from: g.start_date > today ? g.start_date : today, due: g.due_date,
    });
  } catch (err) {
    if (err instanceof RangeError) throw badRequest('Son demasiadas cuotas; elige un plan semanal o una fecha más cercana', 'TOO_MANY_INSTALLMENTS');
    throw err;
  }
  if (!plan.length) return;
  await db.query(
    `INSERT INTO savings_installments (restaurant_id, goal_id, due_on, amount)
     SELECT $1, $2, x.due_on, x.amount FROM unnest($3::date[], $4::numeric[]) AS x(due_on, amount)`,
    [rid, goalId, plan.map((p) => p.due_on), plan.map((p) => p.amount)],
  );
}

// ---------------------------------------------------------------------------
// Apartados
// ---------------------------------------------------------------------------

router.get('/goals', ah(async (req, res) => {
  const status = req.query.status ? oneOf(String(req.query.status), ['activo', 'completado', 'cancelado'], 'status') : null;
  const data = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const goals = (await db.query(
      `SELECT ${GOAL_COLS} FROM ${GOAL_FROM}
        WHERE g.restaurant_id = $1 AND ${VISIBLE} AND ($4::text IS NULL OR g.status = $4)
        ORDER BY g.status = 'activo' DESC, g.due_date NULLS LAST, g.created_at DESC LIMIT 200`,
      [req.tenant.id, req.user.id, isManager(req.user), status],
    )).rows;
    const rh = isManager(req.user) && await moduleActive(db, req.tenant.id, 'rh');
    return { goals: goals.map((g) => shape(g, req.user, today)), today, can_aguinaldo: rh };
  });
  res.json(data);
}));

router.get('/goals/:id', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const goal = shape(await loadGoal(db, req, req.params.id), req.user, today);
    const [movements, installments, shares] = await Promise.all([
      db.query(
        `SELECT m.id, m.kind, m.amount, to_char(m.occurred_on, 'YYYY-MM-DD') AS occurred_on, m.notes, m.created_at,
                u.name AS created_by_name, i.id AS installment_id
           FROM savings_movements m
           LEFT JOIN users u ON u.id = m.created_by AND u.restaurant_id = m.restaurant_id
           LEFT JOIN savings_installments i ON i.movement_id = m.id
          WHERE m.restaurant_id = $1 AND m.goal_id = $2 ORDER BY m.occurred_on DESC, m.created_at DESC LIMIT 500`,
        [req.tenant.id, goal.id],
      ),
      db.query(
        `SELECT i.id, to_char(i.due_on, 'YYYY-MM-DD') AS due_on, i.amount, (i.movement_id IS NOT NULL) AS done, i.done_at, u.name AS done_by_name
           FROM savings_installments i LEFT JOIN users u ON u.id = i.done_by AND u.restaurant_id = i.restaurant_id
          WHERE i.restaurant_id = $1 AND i.goal_id = $2 ORDER BY i.due_on`,
        [req.tenant.id, goal.id],
      ),
      goal.access === 'manage' ? db.query(
        `SELECT s.user_id, u.name, u.role, s.can_edit FROM savings_shares s
           JOIN users u ON u.id = s.user_id AND u.restaurant_id = s.restaurant_id
          WHERE s.restaurant_id = $1 AND s.goal_id = $2 ORDER BY u.name`,
        [req.tenant.id, goal.id],
      ) : { rows: [] },
    ]);
    let aguinaldo = null;
    if (goal.kind === 'aguinaldo' && isManager(req.user) && await moduleActive(db, req.tenant.id, 'rh')) {
      aguinaldo = await aguinaldoTarget(db, req.tenant.id, goal.aguinaldo_year, goal.branch_id);
    }
    return { goal, movements: movements.rows, installments: installments.rows, shares: shares.rows, aguinaldo };
  });
  res.json(data);
}));

router.post('/goals', ah(async (req, res) => {
  const b = req.body || {};
  const f = goalFields(b, true);
  if (f.target_amount === undefined) throw badRequest('Indica la meta', 'MISSING_FIELD');
  const scope = oneOf(b.scope ?? 'negocio', ['negocio', 'personal'], 'scope');
  if (scope === 'negocio' && !isManager(req.user)) throw forbidden('Solo admin y gerente crean apartados del negocio');
  let branchId = null;
  if (scope === 'negocio' && b.branch_id) {
    branchId = requireUuid(String(b.branch_id), 'branch_id');
    if (!canAccessBranch(req.user, branchId)) throw forbidden('No tienes acceso a esa sucursal', 'BRANCH_FORBIDDEN');
  }
  const goal = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const start = f.start_date || today;
    checkPlan({ ...f, start_date: start });
    const { id } = (await db.query(
      `INSERT INTO savings_goals (restaurant_id, scope, branch_id, owner_id, name, description, color, target_amount,
                                  frequency, weekdays, start_date, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, '#3B82F6'), $8, $9, coalesce($10, '{1,2,3,4,5,6}'::smallint[]), $11, $12) RETURNING id`,
      [req.tenant.id, scope, branchId, req.user.id, f.name, f.description ?? null, f.color ?? null, f.target_amount,
        f.frequency ?? null, f.weekdays ?? null, start, f.due_date ?? null],
    )).rows[0];
    await replan(db, req.tenant.id, id, today);
    return shape(await loadGoal(db, req, id), req.user, today);
  });
  res.status(201).json({ goal });
}));

const PLAN_FIELDS = ['target_amount', 'frequency', 'weekdays', 'start_date', 'due_date', 'status'];

router.put('/goals/:id', ah(async (req, res) => {
  const b = req.body || {};
  const f = { ...goalFields(b, false), status: oneOf(b.status, ['activo', 'completado', 'cancelado'], 'status') };
  const goal = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const current = await loadGoal(db, req, req.params.id, 'manage');
    if (current.kind === 'aguinaldo' && f.due_date !== undefined && f.due_date !== current.due_date) {
      throw badRequest('El aguinaldo vence el 20 de diciembre', 'INVALID_FIELD');
    }
    const next = { ...current, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) };
    checkPlan(next);
    const entries = Object.entries(f).filter(([, v]) => v !== undefined);
    if (!entries.length) throw badRequest('Nada que actualizar', 'NOTHING_TO_UPDATE');
    await db.query(
      `UPDATE savings_goals SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
        WHERE restaurant_id = $1 AND id = $2`,
      [req.tenant.id, current.id, ...entries.map(([, v]) => v)],
    );
    if (entries.some(([k]) => PLAN_FIELDS.includes(k))) await replan(db, req.tenant.id, current.id, today);
    return shape(await loadGoal(db, req, current.id), req.user, today);
  });
  res.json({ goal });
}));

// Borrar solo si no tiene movimientos; si ya tiene, se cancela.
router.delete('/goals/:id', ah(async (req, res) => {
  await withTenant(req.tenant.id, async (db) => {
    const goal = await loadGoal(db, req, req.params.id, 'manage');
    const used = await db.query('SELECT 1 FROM savings_movements WHERE restaurant_id = $1 AND goal_id = $2 LIMIT 1', [req.tenant.id, goal.id]);
    if (used.rowCount) throw new HttpError(409, 'El apartado ya tiene movimientos: cancélalo en lugar de borrarlo', 'GOAL_HAS_MOVEMENTS');
    await db.query('DELETE FROM savings_goals WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, goal.id]);
  });
  res.status(204).end();
}));

// Rehacer las cuotas pendientes con lo que falta (p. ej. tras un retiro).
router.post('/goals/:id/replan', ah(async (req, res) => {
  const goal = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const current = await loadGoal(db, req, req.params.id, 'manage');
    await replan(db, req.tenant.id, current.id, today);
    return shape(await loadGoal(db, req, current.id), req.user, today);
  });
  res.json({ goal });
}));

// ---------------------------------------------------------------------------
// Movimientos y cuotas
// ---------------------------------------------------------------------------

async function insertMovement(db, req, goalId, { kind, amount, occurredOn, notes }) {
  return (await db.query(
    `INSERT INTO savings_movements (restaurant_id, goal_id, kind, amount, occurred_on, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.tenant.id, goalId, kind, amount, occurredOn, notes ?? null, req.user.id],
  )).rows[0].id;
}

router.post('/goals/:id/movements', ah(async (req, res) => {
  const b = req.body || {};
  const kind = oneOf(b.kind, ['deposito', 'retiro'], 'kind');
  if (!kind) throw badRequest('Indica si es depósito o retiro', 'MISSING_FIELD');
  const amount = money(b.amount, { field: 'amount' });
  if (!(amount > 0)) throw badRequest('El monto debe ser mayor a cero', 'INVALID_FIELD');
  const notes = str(b.notes, { field: 'notes', max: 300 });
  const goal = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const current = await loadGoal(db, req, req.params.id, 'edit');
    if (current.status === 'cancelado') throw badRequest('El apartado está cancelado', 'GOAL_CANCELLED');
    if (kind === 'retiro' && toCents(amount) > toCents(current.balance)) {
      throw badRequest(`Solo hay ${Number(current.balance).toFixed(2)} apartados`, 'INSUFFICIENT_BALANCE');
    }
    await insertMovement(db, req, current.id, { kind, amount, occurredOn: readDate(b.occurred_on, 'occurred_on') || today, notes });
    // Un deposito o retiro fuera de las cuotas cambia lo que falta: se reparte de nuevo.
    await replan(db, req.tenant.id, current.id, today);
    return shape(await loadGoal(db, req, current.id), req.user, today);
  });
  res.status(201).json({ goal });
}));

router.delete('/movements/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const m = (await db.query('SELECT id, goal_id, created_by FROM savings_movements WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, req.params.id])).rows[0];
    if (!m) throw notFound('Movimiento no encontrado', 'MOVEMENT_NOT_FOUND');
    const goal = await loadGoal(db, req, m.goal_id, 'edit');
    if (accessOf(goal, req.user) !== 'manage' && m.created_by !== req.user.id) {
      throw forbidden('Solo quien lo registró o quien administra el apartado puede borrarlo', 'GOAL_FORBIDDEN');
    }
    // Si era una cuota, la cuota vuelve a quedar pendiente; si no, se reparte de nuevo lo que falta.
    const fromInstallment = await db.query(
      'UPDATE savings_installments SET movement_id = NULL, done_at = NULL, done_by = NULL WHERE restaurant_id = $1 AND movement_id = $2',
      [req.tenant.id, m.id],
    );
    await db.query('DELETE FROM savings_movements WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, m.id]);
    if (!fromInstallment.rowCount) await replan(db, req.tenant.id, goal.id, await todayFor(db, req));
  });
  res.status(204).end();
}));

// Marcar una cuota como apartada (crea su deposito) o desmarcarla (lo borra).
router.patch('/installments/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const done = bool((req.body || {}).done, 'done');
  if (done === undefined) throw badRequest('Indica done', 'MISSING_FIELD');
  const goal = await withTenant(req.tenant.id, async (db) => {
    const today = await todayFor(db, req);
    const inst = (await db.query(
      `SELECT id, goal_id, amount, to_char(due_on, 'YYYY-MM-DD') AS due_on, movement_id
         FROM savings_installments WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [req.tenant.id, req.params.id],
    )).rows[0];
    if (!inst) throw notFound('Cuota no encontrada', 'INSTALLMENT_NOT_FOUND');
    const current = await loadGoal(db, req, inst.goal_id, 'edit');
    if (current.status === 'cancelado') throw badRequest('El apartado está cancelado', 'GOAL_CANCELLED');
    if (done && !inst.movement_id) {
      const movementId = await insertMovement(db, req, current.id, {
        kind: 'deposito', amount: inst.amount, occurredOn: today, notes: `Cuota del ${inst.due_on}`,
      });
      await db.query('UPDATE savings_installments SET movement_id = $3, done_at = now(), done_by = $4 WHERE restaurant_id = $1 AND id = $2',
        [req.tenant.id, inst.id, movementId, req.user.id]);
    } else if (!done && inst.movement_id) {
      await db.query('UPDATE savings_installments SET movement_id = NULL, done_at = NULL, done_by = NULL WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, inst.id]);
      await db.query('DELETE FROM savings_movements WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, inst.movement_id]);
    }
    return shape(await loadGoal(db, req, current.id), req.user, today);
  });
  res.json({ goal });
}));

// ---------------------------------------------------------------------------
// Compartir
// ---------------------------------------------------------------------------

// Usuarios con quien se puede compartir (activos del restaurante, menos uno mismo).
router.get('/people', ah(async (req, res) => {
  const people = await withTenant(req.tenant.id, async (db) => (await db.query(
    'SELECT id, name, role FROM users WHERE restaurant_id = $1 AND active AND id <> $2 ORDER BY name',
    [req.tenant.id, req.user.id],
  )).rows);
  res.json({ people });
}));

router.put('/goals/:id/shares/:userId', ah(async (req, res) => {
  requireUuid(req.params.userId, 'user_id');
  const canEdit = bool((req.body || {}).can_edit, 'can_edit') ?? false;
  await withTenant(req.tenant.id, async (db) => {
    const goal = await loadGoal(db, req, req.params.id, 'manage');
    if (req.params.userId === goal.owner_id) throw badRequest('El dueño ya tiene acceso', 'INVALID_FIELD');
    const user = await db.query('SELECT 1 FROM users WHERE restaurant_id = $1 AND id = $2 AND active', [req.tenant.id, req.params.userId]);
    if (!user.rowCount) throw notFound('Usuario no encontrado', 'USER_NOT_FOUND');
    await db.query(
      `INSERT INTO savings_shares (restaurant_id, goal_id, user_id, can_edit) VALUES ($1, $2, $3, $4)
       ON CONFLICT (goal_id, user_id) DO UPDATE SET can_edit = EXCLUDED.can_edit`,
      [req.tenant.id, goal.id, req.params.userId, canEdit],
    );
  });
  res.json({ ok: true });
}));

// Quitar acceso: quien administra el apartado, o el propio usuario para salirse.
router.delete('/goals/:id/shares/:userId', ah(async (req, res) => {
  requireUuid(req.params.userId, 'user_id');
  await withTenant(req.tenant.id, async (db) => {
    const goal = await loadGoal(db, req, req.params.id);
    if (accessOf(goal, req.user) !== 'manage' && req.params.userId !== req.user.id) throw forbidden('Solo quien administra el apartado puede quitar accesos', 'GOAL_FORBIDDEN');
    await db.query('DELETE FROM savings_shares WHERE restaurant_id = $1 AND goal_id = $2 AND user_id = $3', [req.tenant.id, goal.id, req.params.userId]);
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Aguinaldo (requiere tambien el modulo rh)
// ---------------------------------------------------------------------------

/** Aguinaldo pendiente del año: empleados activos (de una sucursal o todos) que aun no lo cobran. */
async function aguinaldoTarget(db, rid, year, branchId) {
  const s = await getPayrollSettings(db, rid);
  const employees = (await employeesInRange(db, rid, `${year}-01-01`, `${year}-12-31`, { branchId: branchId || undefined }))
    .filter((e) => e.active);
  const paid = new Set((await db.query('SELECT employee_id FROM aguinaldo_payments WHERE restaurant_id = $1 AND year = $2', [rid, year])).rows
    .map((r) => r.employee_id));
  const rows = employees.map((e) => ({
    employee_id: e.id, full_name: e.full_name, branch_name: e.branch_name,
    ...aguinaldoFor(e, year, Number(s.aguinaldo_days), Number(s.daily_hours)),
    paid: paid.has(e.id),
  }));
  const total = fromCents(rows.filter((r) => !r.paid).reduce((sum, r) => sum + toCents(r.amount), 0));
  return { year, total, employees: rows };
}

async function requireRh(db, req) {
  if (!isManager(req.user)) throw forbidden('Solo admin y gerente manejan el aguinaldo');
  if (!await moduleActive(db, req.tenant.id, 'rh')) {
    throw new HttpError(402, 'La meta de aguinaldo usa los empleados de Recursos humanos; contrata ese módulo para usarla.', 'MODULE_REQUIRED');
  }
}

router.post('/aguinaldo', ah(async (req, res) => {
  const b = req.body || {};
  const frequency = b.frequency === undefined ? 'semanal' : (b.frequency ? oneOf(b.frequency, FREQUENCIES, 'frequency') : null);
  const weekdays = readWeekdays(b.weekdays);
  const branchId = b.branch_id ? requireUuid(String(b.branch_id), 'branch_id') : null;
  const goal = await withTenant(req.tenant.id, async (db) => {
    await requireRh(db, req);
    const today = await todayFor(db, req);
    const year = int(b.year ?? today.slice(0, 4), { field: 'year', min: 2000, max: 2100 });
    const due = aguinaldoDueDate(year);
    if (due < today) throw badRequest(`El aguinaldo de ${year} ya venció`, 'INVALID_FIELD');
    let branchName = 'todas las sucursales';
    if (branchId) {
      const br = (await db.query('SELECT name FROM branches WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, branchId])).rows[0];
      if (!br) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
      branchName = br.name;
    }
    const dup = await db.query(
      `SELECT 1 FROM savings_goals WHERE restaurant_id = $1 AND kind = 'aguinaldo' AND aguinaldo_year = $2
          AND branch_id IS NOT DISTINCT FROM $3 AND status <> 'cancelado'`,
      [req.tenant.id, year, branchId],
    );
    if (dup.rowCount) throw new HttpError(409, 'Ya hay una meta de aguinaldo de ese año para esa sucursal', 'AGUINALDO_EXISTS');
    const { total } = await aguinaldoTarget(db, req.tenant.id, year, branchId);
    if (!(total > 0)) throw badRequest('No hay aguinaldo pendiente: revisa que haya empleados activos con salario', 'NOTHING_TO_SAVE');
    const start = readDate(b.start_date, 'start_date') || today;
    checkPlan({ frequency, due_date: due, start_date: start });
    const { id } = (await db.query(
      `INSERT INTO savings_goals (restaurant_id, kind, scope, branch_id, owner_id, name, color, target_amount,
                                  frequency, weekdays, start_date, due_date, aguinaldo_year)
       VALUES ($1, 'aguinaldo', 'negocio', $2, $3, $4, '#F59E0B', $5, $6, coalesce($7, '{1,2,3,4,5,6}'::smallint[]), $8, $9, $10) RETURNING id`,
      [req.tenant.id, branchId, req.user.id, `Aguinaldo ${year} · ${branchName}`, total, frequency, weekdays ?? null, start, due, year],
    )).rows[0];
    await replan(db, req.tenant.id, id, today);
    return shape(await loadGoal(db, req, id), req.user, today);
  });
  res.status(201).json({ goal });
}));

// Recalcular la meta con los empleados de hoy (altas, bajas, aumentos, pagos ya hechos).
router.post('/goals/:id/recalculate', ah(async (req, res) => {
  const goal = await withTenant(req.tenant.id, async (db) => {
    await requireRh(db, req);
    const today = await todayFor(db, req);
    const current = await loadGoal(db, req, req.params.id, 'manage');
    if (current.kind !== 'aguinaldo') throw badRequest('Solo las metas de aguinaldo se recalculan', 'INVALID_FIELD');
    const { total } = await aguinaldoTarget(db, req.tenant.id, current.aguinaldo_year, current.branch_id);
    if (total > 0) {
      await db.query('UPDATE savings_goals SET target_amount = $3, updated_at = now() WHERE restaurant_id = $1 AND id = $2', [req.tenant.id, current.id, total]);
    }
    await replan(db, req.tenant.id, current.id, today);
    return shape(await loadGoal(db, req, current.id), req.user, today);
  });
  res.json({ goal });
}));

export default router;
