// Configuracion de RH: areas, reglas de nomina, dias festivos y
// restriccion del checador por sucursal.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { getPayrollSettings } from '../../services/rh/attendance.js';
import { validIpRule } from '../../services/rh/clock.js';
import { isDateStr } from '../../services/rh/dates.js';
import { mexicanHolidays } from '../../services/rh/holidays.js';
import {
  ah, badRequest, bool, buildSet, money, notFound, requireUuid, str,
} from '../../utils/http.js';
import { int } from '../pos/common.js';
import { adminOnly, manager } from './common.js';

const router = Router();

// --- Areas ---

router.get('/areas', manager, ah(async (req, res) => {
  const areas = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT a.id, a.name, a.active, count(e.id)::int AS employees
       FROM hr_areas a LEFT JOIN employees e ON e.area_id = a.id AND e.restaurant_id = a.restaurant_id AND e.active
      WHERE a.restaurant_id = $1 GROUP BY a.id ORDER BY a.name`,
    [req.tenant.id],
  )).rows);
  res.json({ areas });
}));

router.post('/areas', manager, ah(async (req, res) => {
  const name = str(req.body?.name, { field: 'name', required: true, max: 80 });
  const area = await withTenant(req.tenant.id, async (db) => (await db.query(
    'INSERT INTO hr_areas (restaurant_id, name) VALUES ($1, $2) RETURNING id, name, active',
    [req.tenant.id, name],
  )).rows[0]);
  res.status(201).json({ area });
}));

router.patch('/areas/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  const set = buildSet({
    name: str(req.body?.name, { field: 'name', max: 80 }) ?? undefined,
    active: bool(req.body?.active, 'active'),
  }, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const area = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE hr_areas SET ${set.sql} WHERE id = $1 AND restaurant_id = $2 RETURNING id, name, active`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]);
  if (!area) throw notFound('Área no encontrada', 'AREA_NOT_FOUND');
  res.json({ area });
}));

router.delete('/areas/:id', manager, ah(async (req, res) => {
  requireUuid(req.params.id);
  await withTenant(req.tenant.id, async (db) => {
    await db.query('UPDATE employees SET area_id = NULL WHERE area_id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    const { rowCount } = await db.query('DELETE FROM hr_areas WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Área no encontrada', 'AREA_NOT_FOUND');
  });
  res.status(204).end();
}));

// --- Reglas de nomina ---

router.get('/settings', manager, ah(async (req, res) => {
  const settings = await withTenant(req.tenant.id, (db) => getPayrollSettings(db, req.tenant.id));
  res.json({ settings });
}));

function factor(value, field, { min = 0, max = 10 } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`El campo "${field}" debe estar entre ${min} y ${max}`, 'INVALID_FIELD');
  }
  return Math.round(n * 100) / 100;
}

router.put('/settings', adminOnly, ah(async (req, res) => {
  const b = req.body || {};
  const fields = {
    week_start_day: int(b.week_start_day, { field: 'week_start_day', min: 0, max: 6 }),
    daily_hours: factor(b.daily_hours, 'daily_hours', { min: 1, max: 24 }),
    tolerance_minutes: int(b.tolerance_minutes, { field: 'tolerance_minutes', min: 0, max: 240 }),
    tardiness_penalty: money(b.tardiness_penalty, { field: 'tardiness_penalty' }),
    tardiness_proportional: bool(b.tardiness_proportional, 'tardiness_proportional'),
    absence_penalty: money(b.absence_penalty, { field: 'absence_penalty' }),
    pay_rest_days: bool(b.pay_rest_days, 'pay_rest_days'),
    overtime_enabled: bool(b.overtime_enabled, 'overtime_enabled'),
    overtime_block_minutes: int(b.overtime_block_minutes, { field: 'overtime_block_minutes', min: 1, max: 120 }),
    overtime_double_weekly_hours: int(b.overtime_double_weekly_hours, { field: 'overtime_double_weekly_hours', min: 0, max: 60 }),
    overtime_double_factor: factor(b.overtime_double_factor, 'overtime_double_factor', { min: 1 }),
    overtime_triple_factor: factor(b.overtime_triple_factor, 'overtime_triple_factor', { min: 1 }),
    holiday_worked_factor: factor(b.holiday_worked_factor, 'holiday_worked_factor'),
    rest_day_worked_factor: factor(b.rest_day_worked_factor, 'rest_day_worked_factor'),
    sunday_premium_pct: factor(b.sunday_premium_pct, 'sunday_premium_pct', { max: 100 }),
    official_holidays: bool(b.official_holidays, 'official_holidays'),
    punctuality_bonus: money(b.punctuality_bonus, { field: 'punctuality_bonus' }),
    attendance_bonus: money(b.attendance_bonus, { field: 'attendance_bonus' }),
    // LFT art. 87: minimo 15 dias.
    aguinaldo_days: int(b.aguinaldo_days, { field: 'aguinaldo_days', min: 15, max: 90 }),
  };
  const set = buildSet(fields, 2);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const settings = await withTenant(req.tenant.id, async (db) => {
    await getPayrollSettings(db, req.tenant.id);
    return (await db.query(
      `UPDATE payroll_settings SET ${set.sql}, updated_at = now() WHERE restaurant_id = $1 RETURNING *`,
      [req.tenant.id, ...set.values],
    )).rows[0];
  });
  res.json({ settings });
}));

// --- Dias festivos ---

router.get('/holidays', manager, ah(async (req, res) => {
  const year = int(req.query.year ?? new Date().getFullYear(), { field: 'year', min: 2000, max: 2100 });
  const data = await withTenant(req.tenant.id, async (db) => {
    const settings = await getPayrollSettings(db, req.tenant.id);
    const custom = (await db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, name FROM hr_holidays
        WHERE restaurant_id = $1 AND extract(year FROM date) = $2 ORDER BY date`,
      [req.tenant.id, year],
    )).rows;
    return { official_enabled: settings.official_holidays, official: mexicanHolidays(year), custom };
  });
  res.json({ year, ...data });
}));

router.post('/holidays', adminOnly, ah(async (req, res) => {
  const date = req.body?.date;
  if (!isDateStr(date)) throw badRequest('Fecha inválida (AAAA-MM-DD)', 'INVALID_FIELD');
  const name = str(req.body?.name, { field: 'name', required: true, max: 80 });
  const holiday = await withTenant(req.tenant.id, async (db) => (await db.query(
    `INSERT INTO hr_holidays (restaurant_id, date, name) VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, date) DO UPDATE SET name = EXCLUDED.name
     RETURNING to_char(date, 'YYYY-MM-DD') AS date, name`,
    [req.tenant.id, date, name],
  )).rows[0]);
  res.status(201).json({ holiday });
}));

router.delete('/holidays/:date', adminOnly, ah(async (req, res) => {
  if (!isDateStr(req.params.date)) throw badRequest('Fecha inválida', 'INVALID_FIELD');
  const deleted = await withTenant(req.tenant.id, async (db) => (await db.query(
    'DELETE FROM hr_holidays WHERE restaurant_id = $1 AND date = $2',
    [req.tenant.id, req.params.date],
  )).rowCount);
  if (!deleted) throw notFound('Día no encontrado', 'HOLIDAY_NOT_FOUND');
  res.status(204).end();
}));

// --- Restriccion del checador por sucursal ---

router.get('/clock-settings', manager, ah(async (req, res) => {
  const branches = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT b.id AS branch_id, b.name AS branch_name, coalesce(c.geo_enabled, false) AS geo_enabled,
            c.latitude, c.longitude, coalesce(c.radius_meters, 150) AS radius_meters,
            coalesce(c.allowed_ips, '{}') AS allowed_ips
       FROM branches b LEFT JOIN hr_clock_settings c ON c.branch_id = b.id AND c.restaurant_id = b.restaurant_id
      WHERE b.restaurant_id = $1 ORDER BY b.name`,
    [req.tenant.id],
  )).rows);
  res.json({ branches });
}));

function coord(value, field, limit) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw badRequest(`El campo "${field}" no es válido`, 'INVALID_FIELD');
  return Math.round(n * 1e6) / 1e6;
}

router.put('/clock-settings/:branchId', manager, ah(async (req, res) => {
  requireUuid(req.params.branchId, 'branch_id');
  const b = req.body || {};
  const geo = bool(b.geo_enabled, 'geo_enabled') ?? false;
  const lat = coord(b.latitude, 'latitude', 90);
  const lon = coord(b.longitude, 'longitude', 180);
  if (geo && (lat === null || lon === null)) throw badRequest('Para la geocerca indica latitud y longitud', 'MISSING_FIELD');
  const radius = int(b.radius_meters ?? 150, { field: 'radius_meters', min: 10, max: 100000 });
  const ips = b.allowed_ips ?? [];
  if (!Array.isArray(ips) || ips.length > 50 || !ips.every((ip) => typeof ip === 'string' && validIpRule(ip))) {
    throw badRequest('Lista de IPs inválida (IP exacta o rango IPv4 como 192.168.1.0/24)', 'INVALID_FIELD');
  }
  const settings = await withTenant(req.tenant.id, async (db) => {
    const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2', [req.params.branchId, req.tenant.id]);
    if (!ok.rowCount) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
    return (await db.query(
      `INSERT INTO hr_clock_settings (restaurant_id, branch_id, geo_enabled, latitude, longitude, radius_meters, allowed_ips)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (branch_id) DO UPDATE SET geo_enabled = EXCLUDED.geo_enabled, latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude, radius_meters = EXCLUDED.radius_meters, allowed_ips = EXCLUDED.allowed_ips,
         updated_at = now()
       RETURNING branch_id, geo_enabled, latitude, longitude, radius_meters, allowed_ips`,
      [req.tenant.id, req.params.branchId, geo, lat, lon, radius, ips.map((s) => s.trim())],
    )).rows[0];
  });
  res.json({ settings });
}));

export default router;
