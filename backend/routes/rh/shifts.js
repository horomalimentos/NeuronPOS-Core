// Turnos y rol semanal (modulo 'turnos', ademas de 'rh'): catalogo de
// turnos, rol por semana (asignar, descanso, a mano, copiar la semana) y el
// rol del propio empleado.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireModule } from '../../middleware/requireModule.js';
import { addDays, localToday } from '../../services/rh/dates.js';
import {
  TEMPLATE_COLUMNS, copyWeek, currentWeekStart, listTemplates, readDate, readTime, saveDays, weekView,
} from '../../services/rh/shifts.js';
import {
  ah, badRequest, bool, notFound, requireUuid, str,
} from '../../utils/http.js';
import { manager } from './common.js';

const router = Router();
router.use(requireModule('turnos'));

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function templateFields(b, creating) {
  const f = {
    name: str(b.name, { field: 'name', required: creating, max: 60 }),
    start_time: b.start_time === undefined && !creating ? undefined : readTime(b.start_time, 'start_time'),
    end_time: b.end_time === undefined && !creating ? undefined : readTime(b.end_time, 'end_time'),
    color: b.color === undefined ? undefined : String(b.color),
    active: bool(b.active, 'active'),
  };
  if (f.color !== undefined && !COLOR_RE.test(f.color)) throw badRequest('El color debe ser #RRGGBB', 'INVALID_FIELD');
  if (f.start_time && f.start_time === f.end_time) throw badRequest('La entrada y la salida no pueden ser iguales', 'INVALID_FIELD');
  return f;
}

router.get('/templates', manager, ah(async (req, res) => {
  res.json({ templates: await withTenant(req.tenant.id, (db) => listTemplates(db, req.tenant.id)) });
}));

router.post('/templates', manager, ah(async (req, res) => {
  const f = templateFields(req.body || {}, true);
  const template = await withTenant(req.tenant.id, async (db) => (await db.query(
    `INSERT INTO shift_templates (restaurant_id, name, start_time, end_time, color)
     VALUES ($1, $2, $3, $4, coalesce($5, '#3B82F6')) RETURNING ${TEMPLATE_COLUMNS}`,
    [req.tenant.id, f.name, f.start_time, f.end_time, f.color ?? null],
  )).rows[0]);
  res.status(201).json({ template });
}));

router.patch('/templates/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = templateFields(req.body || {}, false);
  const template = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE shift_templates SET name = coalesce($3, name), start_time = coalesce($4, start_time),
            end_time = coalesce($5, end_time), color = coalesce($6, color), active = coalesce($7, active)
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${TEMPLATE_COLUMNS}`,
    [req.params.id, req.tenant.id, f.name ?? null, f.start_time ?? null, f.end_time ?? null, f.color ?? null, f.active ?? null],
  )).rows[0]);
  if (!template) throw notFound('Turno no encontrado', 'SHIFT_NOT_FOUND');
  res.json({ template });
}));

// Un turno ya usado en el rol no se borra (el historial lo nombra): se desactiva.
router.delete('/templates/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await withTenant(req.tenant.id, async (db) => {
    const used = (await db.query(
      'SELECT 1 FROM employee_shift_days WHERE restaurant_id = $1 AND shift_id = $2 LIMIT 1', [req.tenant.id, req.params.id],
    )).rowCount;
    const { rowCount } = used
      ? await db.query('UPDATE shift_templates SET active = false WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id])
      : await db.query('DELETE FROM shift_templates WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Turno no encontrado', 'SHIFT_NOT_FOUND');
    return used ? 'desactivado' : 'borrado';
  });
  res.json({ result });
}));

/** Semana pedida o la actual (hora local de la sucursal elegida, o de la primera). */
async function startOf(db, req, value, branchId) {
  if (value) return readDate(value, 'start');
  const b = (await db.query(
    'SELECT timezone FROM branches WHERE restaurant_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at LIMIT 1',
    [req.tenant.id, branchId ?? null],
  )).rows[0];
  return currentWeekStart(db, req.tenant.id, localToday(b?.timezone || 'America/Mexico_City'));
}

router.get('/week', manager, ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : undefined;
  const data = await withTenant(req.tenant.id, async (db) => {
    const start = await startOf(db, req, req.query.start, branchId);
    return { ...(await weekView(db, req.tenant.id, start, { branchId })), templates: await listTemplates(db, req.tenant.id) };
  });
  res.json(data);
}));

router.put('/days', manager, ah(async (req, res) => {
  const saved = await withTenant(req.tenant.id, (db) => saveDays(db, req.tenant.id, (req.body || {}).items, req.user.id));
  res.json({ saved });
}));

router.post('/copy-week', manager, ah(async (req, res) => {
  const b = req.body || {};
  const from = readDate(b.from, 'from');
  const to = readDate(b.to, 'to');
  const branchId = b.branch_id ? requireUuid(b.branch_id, 'branch_id') : undefined;
  const copied = await withTenant(req.tenant.id, (db) => copyWeek(db, req.tenant.id, from, to, {
    branchId, overwrite: Boolean(b.overwrite), userId: req.user.id,
  }));
  res.json({ copied });
}));

// El rol del propio empleado (cualquier rol ligado a un empleado).
router.get('/mine', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const emp = (await db.query(
      `SELECT e.id, b.timezone FROM employees e JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
        WHERE e.restaurant_id = $1 AND e.user_id = $2`,
      [req.tenant.id, req.user.id],
    )).rows[0];
    if (!emp) throw notFound('Tu usuario no está ligado a un empleado', 'NOT_AN_EMPLOYEE');
    const start = req.query.start ? readDate(req.query.start, 'start')
      : await currentWeekStart(db, req.tenant.id, localToday(emp.timezone));
    const week = await weekView(db, req.tenant.id, start, { employeeIds: [emp.id] });
    return { start, end: addDays(start, 6), today: localToday(emp.timezone), days: week.employees[0]?.days || [] };
  });
  res.json(data);
}));

export default router;
