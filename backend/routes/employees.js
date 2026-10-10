// Empleados del restaurante (expediente, sueldo, horario y NIP del
// checador). Los usan los modulos 'rh' y 'empleado_mes': basta con tener uno
// de los dos. Leer y escribir: admin y gerente.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireAnyModule } from '../middleware/requireModule.js';
import { EMPLOYEE_COLUMNS, EMPLOYEE_FROM } from '../services/rh/attendance.js';
import { PIN_RE } from '../services/rh/clock.js';
import { isDateStr, timeToMinutes } from '../services/rh/dates.js';
import { FREQUENCIES } from '../services/rh/payrollMath.js';
import {
  HttpError, ah, badRequest, bool, buildSet, money, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';

const router = Router();
router.use(authenticateUser, requireAnyModule('rh', 'empleado_mes'));
const manager = requireRole('admin', 'gerente');

const upper = (v) => (typeof v === 'string' ? v.toUpperCase() : v);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function dateField(value, field, { nullable = true } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (nullable) return null;
    throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
  }
  if (!isDateStr(value)) throw badRequest(`El campo "${field}" debe ser una fecha AAAA-MM-DD`, 'INVALID_FIELD');
  return value;
}

function uuidOrNull(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return requireUuid(value, field);
}

function employeeFields(body, creating) {
  const f = {
    full_name: str(body.full_name, { field: 'full_name', required: creating, max: 160 }),
    user_id: uuidOrNull(body.user_id, 'user_id'),
    branch_id: body.branch_id === undefined ? undefined : requireUuid(body.branch_id, 'branch_id'),
    area_id: uuidOrNull(body.area_id, 'area_id'),
    employee_number: str(body.employee_number, { field: 'employee_number', max: 40 }),
    position: str(body.position, { field: 'position', max: 120 }),
    pay_type: oneOf(body.pay_type, ['diario', 'por_hora'], 'pay_type'),
    daily_salary: money(body.daily_salary, { field: 'daily_salary' }),
    hourly_rate: money(body.hourly_rate, { field: 'hourly_rate' }),
    payment_frequency: oneOf(body.payment_frequency, FREQUENCIES, 'payment_frequency'),
    hire_date: dateField(body.hire_date, 'hire_date', { nullable: false }),
    termination_date: dateField(body.termination_date, 'termination_date'),
    active: bool(body.active, 'active'),
    nss: str(body.nss, { field: 'nss', max: 20 }),
    rfc: upper(str(body.rfc, { field: 'rfc', max: 13 })),
    curp: upper(str(body.curp, { field: 'curp', max: 18 })),
    phone: str(body.phone, { field: 'phone', max: 40 }),
    email: str(body.email, { field: 'email', max: 200 }),
    bank_name: str(body.bank_name, { field: 'bank_name', max: 80 }),
    bank_account: str(body.bank_account, { field: 'bank_account', max: 30 }),
    notes: str(body.notes, { field: 'notes', max: 1000 }),
  };
  if (f.full_name === null) throw badRequest('El nombre no puede quedar vacío', 'MISSING_FIELD');
  if (creating && !f.branch_id) throw badRequest('La sucursal es obligatoria', 'MISSING_FIELD');
  if (f.employee_number === '') f.employee_number = null;
  return f;
}

async function checkRefs(db, restaurantId, f) {
  if (f.branch_id) {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2', [f.branch_id, restaurantId]);
    if (!ok.rowCount) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
  }
  if (f.area_id) {
    const ok = await db.query('SELECT 1 FROM hr_areas WHERE id = $1 AND restaurant_id = $2', [f.area_id, restaurantId]);
    if (!ok.rowCount) throw badRequest('El área no existe', 'AREA_NOT_FOUND');
  }
  if (f.user_id) {
    const ok = await db.query('SELECT 1 FROM users WHERE id = $1 AND restaurant_id = $2', [f.user_id, restaurantId]);
    if (!ok.rowCount) throw badRequest('El usuario no existe', 'USER_NOT_FOUND');
  }
}

export async function getEmployee(db, restaurantId, id) {
  const { rows } = await db.query(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1 AND e.restaurant_id = $2`, [id, restaurantId]);
  const emp = rows[0];
  if (!emp) return null;
  emp.schedule = (await db.query(
    `SELECT day_of_week, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM employee_schedules WHERE restaurant_id = $1 AND employee_id = $2 ORDER BY day_of_week`,
    [restaurantId, id],
  )).rows;
  return emp;
}

function duplicateError(err) {
  if (err?.code === '23505') {
    if (err.constraint === 'employees_restaurant_id_user_id_key') return new HttpError(409, 'Ese usuario ya está ligado a otro empleado', 'USER_ALREADY_LINKED');
    if (err.constraint === 'employees_restaurant_id_employee_number_key') return new HttpError(409, 'Ya existe un empleado con ese número', 'DUPLICATE_EMPLOYEE_NUMBER');
  }
  return err;
}

router.get('/', manager, ah(async (req, res) => {
  const params = [req.tenant.id];
  let where = 'e.restaurant_id = $1';
  if (req.query.branch_id) { params.push(requireUuid(req.query.branch_id, 'branch_id')); where += ` AND e.branch_id = $${params.length}`; }
  if (req.query.active === '1') where += ' AND e.active';
  const employees = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${where} ORDER BY e.active DESC, e.full_name`,
    params,
  )).rows);
  res.json({ employees });
}));

router.get('/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const employee = await withTenant(req.tenant.id, (db) => getEmployee(db, req.tenant.id, req.params.id));
  if (!employee) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
  res.json({ employee });
}));

router.post('/', manager, ah(async (req, res) => {
  const body = req.body || {};
  const f = employeeFields(body, true);
  const schedule = body.schedule === undefined ? undefined : readSchedule(body.schedule);
  const pinHash = body.pin ? await hashPin(body.pin) : undefined;
  try {
    const employee = await withTenant(req.tenant.id, async (db) => {
      await checkRefs(db, req.tenant.id, f);
      const cols = Object.entries({ ...f, pin_hash: pinHash }).filter(([, v]) => v !== undefined);
      const { rows } = await db.query(
        `INSERT INTO employees (restaurant_id, ${cols.map(([k]) => k).join(', ')})
         VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [req.tenant.id, ...cols.map(([, v]) => v)],
      );
      if (schedule) await saveSchedule(db, req.tenant.id, rows[0].id, schedule);
      return getEmployee(db, req.tenant.id, rows[0].id);
    });
    res.status(201).json({ employee });
  } catch (err) {
    throw duplicateError(err);
  }
}));

router.patch('/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = employeeFields(req.body || {}, false);
  try {
    const employee = await withTenant(req.tenant.id, async (db) => {
      await checkRefs(db, req.tenant.id, f);
      const set = buildSet(f, 3);
      if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
      const { rowCount } = await db.query(
        `UPDATE employees SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.tenant.id, ...set.values],
      );
      if (!rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
      return getEmployee(db, req.tenant.id, req.params.id);
    });
    res.json({ employee });
  } catch (err) {
    throw duplicateError(err);
  }
}));

// Solo se borra un empleado sin historial; con checadas o nomina se da de baja.
router.delete('/:id', requireRole('admin'), ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    const used = await db.query(
      `SELECT EXISTS (SELECT 1 FROM time_entries WHERE restaurant_id = $1 AND employee_id = $2)
           OR EXISTS (SELECT 1 FROM payroll_items WHERE restaurant_id = $1 AND employee_id = $2)
           OR EXISTS (SELECT 1 FROM recognition_results WHERE restaurant_id = $1 AND employee_id = $2)
           OR EXISTS (SELECT 1 FROM customer_complaints WHERE restaurant_id = $1 AND responsible_employee_id = $2) AS used`,
      [req.tenant.id, req.params.id],
    );
    if (used.rows[0].used) {
      throw new HttpError(409, 'El empleado tiene historial: dalo de baja en lugar de borrarlo', 'EMPLOYEE_HAS_HISTORY');
    }
    const { rowCount } = await db.query('DELETE FROM employees WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
  });
  res.status(204).end();
}));

// --- Horario semanal ---

function readSchedule(value) {
  if (!Array.isArray(value)) throw badRequest('schedule debe ser una lista', 'INVALID_FIELD');
  const seen = new Set();
  return value.map((d) => {
    const dow = Number(d?.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6 || seen.has(dow)) throw badRequest('Día de la semana inválido o repetido', 'INVALID_SCHEDULE');
    seen.add(dow);
    if (!TIME_RE.test(String(d.start_time)) || !TIME_RE.test(String(d.end_time))) {
      throw badRequest('Las horas deben tener formato HH:MM', 'INVALID_SCHEDULE');
    }
    if (timeToMinutes(d.start_time) === timeToMinutes(d.end_time)) {
      throw badRequest('La entrada y la salida no pueden ser iguales', 'INVALID_SCHEDULE');
    }
    return { day_of_week: dow, start_time: d.start_time, end_time: d.end_time };
  });
}

async function saveSchedule(db, restaurantId, employeeId, schedule) {
  await db.query('DELETE FROM employee_schedules WHERE restaurant_id = $1 AND employee_id = $2', [restaurantId, employeeId]);
  for (const d of schedule) {
    await db.query(
      `INSERT INTO employee_schedules (restaurant_id, employee_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5)`,
      [restaurantId, employeeId, d.day_of_week, d.start_time, d.end_time],
    );
  }
}

// Reemplaza el horario completo (los dias que no vengan son descanso).
router.put('/:id/schedule', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const schedule = readSchedule(req.body?.schedule);
  const employee = await withTenant(req.tenant.id, async (db) => {
    const exists = await db.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!exists.rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
    await saveSchedule(db, req.tenant.id, req.params.id, schedule);
    return getEmployee(db, req.tenant.id, req.params.id);
  });
  res.json({ employee });
}));

// --- NIP del checador ---

async function hashPin(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw badRequest('El NIP debe tener de 4 a 6 dígitos', 'INVALID_PIN');
  return bcrypt.hash(pin, 10);
}

// pin = null lo quita. Cambiarlo tambien quita el bloqueo por intentos.
router.put('/:id/pin', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const pin = req.body?.pin;
  const hash = pin === null ? null : await hashPin(pin);
  await withTenant(req.tenant.id, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE employees SET pin_hash = $3, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.tenant.id, hash],
    );
    if (!rowCount) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
  });
  res.json({ ok: true, has_pin: hash !== null });
}));

export default router;
