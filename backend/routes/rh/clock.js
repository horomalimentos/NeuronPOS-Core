// Checador: kiosco por sucursal (el empleado elige su nombre y teclea su
// NIP), checadas, correcciones manuales con motivo (auditadas) e importacion
// desde otros relojes.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../../config/database.js';
import { kioskLimiter } from '../../middleware/rateLimits.js';
import {
  DUPLICATE_SECONDS, PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, checkClockRestriction, nextKind, normalizeIp,
} from '../../services/rh/clock.js';
import { importClockEvents } from '../../services/rh/clockImport.js';
import { localParts, timeToMinutes } from '../../services/rh/dates.js';
import {
  HttpError, ah, badRequest, forbidden, notFound, oneOf, requireUuid, str,
} from '../../utils/http.js';
import { canAccessBranch, requireBranch } from '../pos/common.js';
import { adminOnly, assertDayEditable, manager, readInstant, readRange } from './common.js';

const router = Router();

// --- Kiosco ---

// Empleados de la sucursal con NIP y si estan dentro o fuera. Cualquier
// usuario con acceso a la sucursal puede abrir el kiosco en su dispositivo.
router.get('/kiosk/:branchId', ah(async (req, res) => {
  const branchId = requireBranch(req, req.params.branchId);
  const data = await withTenant(req.tenant.id, async (db) => {
    const branch = (await db.query('SELECT id, name, timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id])).rows[0];
    if (!branch) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
    const employees = (await db.query(
      `SELECT e.id, e.full_name, e.position,
              (SELECT t.kind FROM time_entries t WHERE t.restaurant_id = e.restaurant_id AND t.employee_id = e.id AND NOT t.voided
                  AND t.occurred_at > now() - interval '20 hours' ORDER BY t.occurred_at DESC LIMIT 1) AS last_kind,
              (SELECT t.occurred_at FROM time_entries t WHERE t.restaurant_id = e.restaurant_id AND t.employee_id = e.id AND NOT t.voided
                  AND t.occurred_at > now() - interval '20 hours' ORDER BY t.occurred_at DESC LIMIT 1) AS last_at
         FROM employees e
        WHERE e.restaurant_id = $1 AND e.branch_id = $2 AND e.active AND e.pin_hash IS NOT NULL
        ORDER BY e.full_name`,
      [req.tenant.id, branchId],
    )).rows;
    const restriction = (await db.query(
      'SELECT geo_enabled, (cardinality(allowed_ips) > 0) AS ip_restricted FROM hr_clock_settings WHERE branch_id = $1 AND restaurant_id = $2',
      [branchId, req.tenant.id],
    )).rows[0] || { geo_enabled: false, ip_restricted: false };
    return { branch, employees: employees.map((e) => ({ ...e, inside: e.last_kind === 'entrada' })), restriction };
  });
  res.json(data);
}));

router.post('/kiosk/clock', kioskLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const employeeId = requireUuid(body.employee_id, 'employee_id');
  const kindRequested = oneOf(body.kind, ['entrada', 'salida'], 'kind');
  if (typeof body.pin !== 'string' || !body.pin) throw badRequest('Escribe tu NIP', 'MISSING_PIN');
  const ip = normalizeIp(req.ip);
  const now = new Date();

  // El intento fallido se guarda (COMMIT) y despues se responde el error.
  const outcome = await withTenant(req.tenant.id, async (db) => {
    const emp = (await db.query(
      `SELECT e.id, e.full_name, e.branch_id, e.active, e.pin_hash, e.pin_failed_attempts, e.pin_locked_until, b.timezone
         FROM employees e JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
        WHERE e.id = $1 AND e.restaurant_id = $2 FOR UPDATE OF e`,
      [employeeId, req.tenant.id],
    )).rows[0];
    if (!emp || emp.branch_id !== branchId || !emp.active || !emp.pin_hash) {
      return { error: new HttpError(404, 'Empleado no encontrado en esta sucursal', 'EMPLOYEE_NOT_FOUND') };
    }
    if (emp.pin_locked_until && new Date(emp.pin_locked_until) > now) {
      const mins = Math.ceil((new Date(emp.pin_locked_until) - now) / 60000);
      return { error: new HttpError(423, `NIP bloqueado por intentos fallidos. Intenta en ${mins} min o pide a tu gerente que lo cambie.`, 'PIN_LOCKED') };
    }
    if (!(await bcrypt.compare(body.pin, emp.pin_hash))) {
      const attempts = emp.pin_failed_attempts + 1;
      const lock = attempts >= PIN_MAX_ATTEMPTS;
      await db.query(
        `UPDATE employees SET pin_failed_attempts = $3, pin_locked_until = $4 WHERE id = $1 AND restaurant_id = $2`,
        [emp.id, req.tenant.id, lock ? 0 : attempts, lock ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60000) : null],
      );
      return {
        error: lock
          ? new HttpError(423, `NIP bloqueado por ${PIN_LOCK_MINUTES} minutos por intentos fallidos`, 'PIN_LOCKED')
          : new HttpError(401, `NIP incorrecto (${PIN_MAX_ATTEMPTS - attempts} intento(s) más)`, 'INVALID_PIN'),
      };
    }
    if (emp.pin_failed_attempts) {
      await db.query('UPDATE employees SET pin_failed_attempts = 0 WHERE id = $1 AND restaurant_id = $2', [emp.id, req.tenant.id]);
    }

    const settings = (await db.query(
      'SELECT geo_enabled, latitude, longitude, radius_meters, allowed_ips FROM hr_clock_settings WHERE branch_id = $1 AND restaurant_id = $2',
      [branchId, req.tenant.id],
    )).rows[0] || null;
    const denied = checkClockRestriction(settings, { ip, latitude: body.latitude, longitude: body.longitude });
    if (denied) return { error: new HttpError(403, denied.error, denied.code) };

    const last = (await db.query(
      `SELECT kind, occurred_at FROM time_entries WHERE restaurant_id = $1 AND employee_id = $2 AND NOT voided
        ORDER BY occurred_at DESC LIMIT 1`,
      [req.tenant.id, emp.id],
    )).rows[0];
    if (last && now - new Date(last.occurred_at) < DUPLICATE_SECONDS * 1000) {
      return { error: new HttpError(409, 'Ya registraste una checada hace un momento', 'CLOCK_DUPLICATE') };
    }
    const kind = kindRequested || nextKind(last, now);
    const lat = Number.isFinite(Number(body.latitude)) && body.latitude !== null ? Number(body.latitude) : null;
    const lon = Number.isFinite(Number(body.longitude)) && body.longitude !== null ? Number(body.longitude) : null;
    const entry = (await db.query(
      `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at, source, latitude, longitude, ip, created_by)
       VALUES ($1, $2, $3, $4, $5, 'kiosco', $6, $7, $8, $9) RETURNING id, kind, occurred_at`,
      [req.tenant.id, emp.id, branchId, kind, now, lat, lon, ip, req.user.id],
    )).rows[0];

    // Aviso de retardo en pantalla (el calculo formal es el de la nomina).
    let lateMinutes = 0;
    if (kind === 'entrada') {
      const local = localParts(now, emp.timezone);
      const dow = new Date(`${local.date}T00:00:00Z`).getUTCDay();
      const sched = (await db.query(
        `SELECT to_char(start_time, 'HH24:MI') AS start_time FROM employee_schedules
          WHERE restaurant_id = $1 AND employee_id = $2 AND day_of_week = $3`,
        [req.tenant.id, emp.id, dow],
      )).rows[0];
      const tol = (await db.query('SELECT tolerance_minutes FROM payroll_settings WHERE restaurant_id = $1', [req.tenant.id])).rows[0];
      if (sched) {
        const late = local.minutes - timeToMinutes(sched.start_time);
        if (late > Number(tol?.tolerance_minutes ?? 0)) lateMinutes = late;
      }
    }
    return { entry, employee_name: emp.full_name, late_minutes: lateMinutes };
  });
  if (outcome.error) throw outcome.error;
  res.status(201).json(outcome);
}));

// --- Checadas (gerentes) ---

const ENTRY_SELECT = `
  SELECT t.id, t.employee_id, e.full_name AS employee_name, t.branch_id, b.name AS branch_name, b.timezone,
         t.kind, t.occurred_at, t.source, t.latitude, t.longitude, t.ip, t.voided, t.created_at, t.updated_at,
         u.name AS created_by_name,
         (SELECT count(*)::int FROM time_entry_audit a WHERE a.restaurant_id = t.restaurant_id AND a.time_entry_id = t.id) AS corrections
    FROM time_entries t
    JOIN employees e ON e.id = t.employee_id AND e.restaurant_id = t.restaurant_id
    JOIN branches b ON b.id = t.branch_id AND b.restaurant_id = t.restaurant_id
    LEFT JOIN users u ON u.id = t.created_by AND u.restaurant_id = t.restaurant_id`;

router.get('/time-entries', manager, ah(async (req, res) => {
  const { from, to } = readRange(req.query, { maxDays: 62 });
  const params = [req.tenant.id, from, to];
  let where = `t.restaurant_id = $1 AND (t.occurred_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3`;
  if (req.query.branch_id) { params.push(requireUuid(req.query.branch_id, 'branch_id')); where += ` AND t.branch_id = $${params.length}`; }
  if (req.query.employee_id) { params.push(requireUuid(req.query.employee_id, 'employee_id')); where += ` AND t.employee_id = $${params.length}`; }
  const entries = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${ENTRY_SELECT} WHERE ${where} ORDER BY t.occurred_at DESC LIMIT 2000`,
    params,
  )).rows);
  res.json({ entries });
}));

async function loadEntry(db, restaurantId, id, { lock = false } = {}) {
  requireUuid(id);
  if (lock) await db.query('SELECT 1 FROM time_entries WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, restaurantId]);
  const entry = (await db.query(`${ENTRY_SELECT} WHERE t.id = $1 AND t.restaurant_id = $2`, [id, restaurantId])).rows[0];
  if (!entry) throw notFound('Checada no encontrada', 'TIME_ENTRY_NOT_FOUND');
  return entry;
}

const snapshot = (e) => ({ kind: e.kind, occurred_at: new Date(e.occurred_at).toISOString(), voided: e.voided });

async function audit(db, req, entryId, action, reason, before, after) {
  await db.query(
    `INSERT INTO time_entry_audit (restaurant_id, time_entry_id, action, reason, before, after, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.tenant.id, entryId, action, reason, before && JSON.stringify(before), after && JSON.stringify(after), req.user.id],
  );
}

const readReason = (body) => str(body?.reason, { field: 'reason', required: true, max: 300 });

// Checada manual (olvido, falla del kiosco). Motivo obligatorio.
router.post('/time-entries', manager, ah(async (req, res) => {
  const body = req.body || {};
  const employeeId = requireUuid(body.employee_id, 'employee_id');
  const kind = oneOf(body.kind, ['entrada', 'salida'], 'kind');
  if (!kind) throw badRequest('Indica si es entrada o salida', 'MISSING_FIELD');
  const reason = readReason(body);
  const entry = await withTenant(req.tenant.id, async (db) => {
    const emp = (await db.query(
      `SELECT e.id, e.branch_id, b.timezone FROM employees e JOIN branches b ON b.id = e.branch_id AND b.restaurant_id = e.restaurant_id
        WHERE e.id = $1 AND e.restaurant_id = $2`,
      [employeeId, req.tenant.id],
    )).rows[0];
    if (!emp) throw notFound('Empleado no encontrado', 'EMPLOYEE_NOT_FOUND');
    if (!canAccessBranch(req.user, emp.branch_id)) throw forbidden('No tienes acceso a esta sucursal', 'BRANCH_FORBIDDEN');
    const at = readInstant(body, emp.timezone);
    if (at > new Date(Date.now() + 5 * 60000)) throw badRequest('No se pueden capturar checadas en el futuro', 'FUTURE_ENTRY');
    await assertDayEditable(db, req.tenant.id, emp.id, localParts(at, emp.timezone).date);
    const { rows } = await db.query(
      `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at, source, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6) RETURNING id, kind, occurred_at, voided`,
      [req.tenant.id, emp.id, emp.branch_id, kind, at, req.user.id],
    );
    await audit(db, req, rows[0].id, 'crear', reason, null, snapshot(rows[0]));
    return loadEntry(db, req.tenant.id, rows[0].id);
  });
  res.status(201).json({ entry });
}));

router.patch('/time-entries/:id', manager, ah(async (req, res) => {
  const body = req.body || {};
  const reason = readReason(body);
  const kind = oneOf(body.kind, ['entrada', 'salida'], 'kind');
  const entry = await withTenant(req.tenant.id, async (db) => {
    const before = await loadEntry(db, req.tenant.id, req.params.id, { lock: true });
    if (before.voided) throw badRequest('La checada está anulada', 'TIME_ENTRY_VOIDED');
    const changesTime = body.date !== undefined || body.time !== undefined || body.occurred_at !== undefined;
    const at = changesTime ? readInstant(body, before.timezone) : new Date(before.occurred_at);
    if (!changesTime && !kind) throw badRequest('No hay cambios', 'NO_CHANGES');
    if (at > new Date(Date.now() + 5 * 60000)) throw badRequest('No se pueden capturar checadas en el futuro', 'FUTURE_ENTRY');
    await assertDayEditable(db, req.tenant.id, before.employee_id, localParts(before.occurred_at, before.timezone).date);
    await assertDayEditable(db, req.tenant.id, before.employee_id, localParts(at, before.timezone).date);
    await db.query(
      `UPDATE time_entries SET occurred_at = $3, kind = $4, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
      [before.id, req.tenant.id, at, kind || before.kind],
    );
    const after = await loadEntry(db, req.tenant.id, before.id);
    await audit(db, req, before.id, 'editar', reason, snapshot(before), snapshot(after));
    return after;
  });
  res.json({ entry });
}));

// Anular en lugar de borrar: la checada y su historial se conservan.
router.post('/time-entries/:id/void', manager, ah(async (req, res) => {
  const reason = readReason(req.body);
  const entry = await withTenant(req.tenant.id, async (db) => {
    const before = await loadEntry(db, req.tenant.id, req.params.id, { lock: true });
    if (before.voided) throw badRequest('La checada ya está anulada', 'TIME_ENTRY_VOIDED');
    await assertDayEditable(db, req.tenant.id, before.employee_id, localParts(before.occurred_at, before.timezone).date);
    await db.query('UPDATE time_entries SET voided = true, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [before.id, req.tenant.id]);
    const after = await loadEntry(db, req.tenant.id, before.id);
    await audit(db, req, before.id, 'anular', reason, snapshot(before), snapshot(after));
    return after;
  });
  res.json({ entry });
}));

router.get('/time-entries/:id/audit', manager, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const entry = await loadEntry(db, req.tenant.id, req.params.id);
    const auditRows = (await db.query(
      `SELECT a.id, a.action, a.reason, a.before, a.after, a.created_at, u.name AS user_name
         FROM time_entry_audit a JOIN users u ON u.id = a.user_id AND u.restaurant_id = a.restaurant_id
        WHERE a.restaurant_id = $1 AND a.time_entry_id = $2 ORDER BY a.created_at`,
      [req.tenant.id, entry.id],
    )).rows;
    return { entry, audit: auditRows };
  });
  res.json(data);
}));

// Importacion de otro reloj checador (formato generico por ahora).
router.post('/time-entries/import', adminOnly, ah(async (req, res) => {
  const adapter = String(req.body?.format || 'generico');
  const result = await withTenant(req.tenant.id, (db) => importClockEvents(db, req.tenant.id, adapter, req.body?.events, { userId: req.user.id }));
  res.json(result);
}));

export default router;
