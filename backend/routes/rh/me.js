// Autoservicio del empleado (cualquier rol): su ficha, horario, checadas,
// asistencia y recibos de nomina aprobados, y la firma (aceptacion) de cada
// recibo. Solo si su usuario esta ligado a un empleado.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { attendanceFor } from '../../services/rh/attendance.js';
import { addDays, localToday } from '../../services/rh/dates.js';
import { hasPendingClaim } from '../../services/rh/extras.js';
import { ITEM_COLUMNS, ITEM_FROM, getPeriod, itemLines } from '../../services/rh/payroll.js';
import { HttpError, ah, badRequest, notFound, requireUuid } from '../../utils/http.js';
import { getEmployee } from '../employees.js';
import { summarize } from './attendance.js';
import { readRange } from './common.js';

const router = Router();

async function myEmployee(db, req) {
  const row = (await db.query('SELECT id FROM employees WHERE restaurant_id = $1 AND user_id = $2', [req.tenant.id, req.user.id])).rows[0];
  if (!row) throw notFound('Tu usuario no está ligado a un empleado. Pide a tu gerente que lo ligue en Recursos humanos.', 'NOT_AN_EMPLOYEE');
  return getEmployee(db, req.tenant.id, row.id);
}

// Solo lo que le toca ver al empleado (sin NIP ni notas internas).
const publicEmployee = (e) => ({
  id: e.id, full_name: e.full_name, employee_number: e.employee_number, position: e.position, area_name: e.area_name,
  branch_id: e.branch_id, branch_name: e.branch_name, timezone: e.timezone, pay_type: e.pay_type,
  payment_frequency: e.payment_frequency, hire_date: e.hire_date, has_pin: e.has_pin, schedule: e.schedule,
});

router.get('/me', ah(async (req, res) => {
  const employee = await withTenant(req.tenant.id, async (db) => publicEmployee(await myEmployee(db, req)));
  res.json({ employee });
}));

router.get('/me/attendance', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    const today = localToday(emp.timezone);
    const { from, to } = readRange(req.query, { maxDays: 62, defaultFrom: addDays(today, -13), defaultTo: today });
    const { days } = await attendanceFor(db, req.tenant.id, [emp], from, to);
    const entries = (await db.query(
      `SELECT id, kind, occurred_at, source, voided FROM time_entries
        WHERE restaurant_id = $1 AND employee_id = $2 AND (occurred_at AT TIME ZONE $5)::date BETWEEN $3 AND $4
        ORDER BY occurred_at DESC`,
      [req.tenant.id, emp.id, from, to, emp.timezone],
    )).rows;
    return { from, to, timezone: emp.timezone, summary: summarize(days.get(emp.id)), days: days.get(emp.id), entries };
  });
  res.json(data);
}));

router.get('/me/receipts', ah(async (req, res) => {
  const receipts = await withTenant(req.tenant.id, async (db) => {
    const emp = await myEmployee(db, req);
    return (await db.query(
      `SELECT ${ITEM_COLUMNS}, p.frequency, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(p.end_date, 'YYYY-MM-DD') AS end_date, p.status AS period_status
         FROM ${ITEM_FROM}
         JOIN payroll_periods p ON p.id = i.period_id AND p.restaurant_id = i.restaurant_id
        WHERE i.restaurant_id = $1 AND i.employee_id = $2 AND p.status IN ('aprobada', 'cerrada')
        ORDER BY p.start_date DESC`,
      [req.tenant.id, emp.id],
    )).rows;
  });
  res.json({ receipts });
}));

async function myReceipt(db, req, id) {
  requireUuid(id);
  const emp = await myEmployee(db, req);
  const item = (await db.query(
    `SELECT ${ITEM_COLUMNS}, i.detail FROM ${ITEM_FROM} WHERE i.id = $1 AND i.restaurant_id = $2 AND i.employee_id = $3`,
    [id, req.tenant.id, emp.id],
  )).rows[0];
  const period = item && await getPeriod(db, req.tenant.id, item.period_id);
  // Un borrador todavia no es del empleado: se ve igual que si no existiera.
  if (!item || period.status === 'borrador') throw notFound('Recibo no encontrado', 'ITEM_NOT_FOUND');
  item.lines = (await itemLines(db, req.tenant.id, [item.id])).get(item.id);
  return { emp, item, period };
}

router.get('/me/receipts/:id', ah(async (req, res) => {
  const { item, period } = await withTenant(req.tenant.id, (db) => myReceipt(db, req, req.params.id));
  res.json({ item, period });
}));

// Firma: el empleado acepta su recibo (casilla + fecha, IP y navegador).
router.post('/me/receipts/:id/sign', ah(async (req, res) => {
  if (req.body?.accept !== true) throw badRequest('Marca la casilla para aceptar tu recibo', 'ACCEPT_REQUIRED');
  const data = await withTenant(req.tenant.id, async (db) => {
    const { emp, item } = await myReceipt(db, req, req.params.id);
    if (item.signed_at) throw new HttpError(409, 'Este recibo ya está firmado', 'ALREADY_SIGNED');
    if (await hasPendingClaim(db, req.tenant.id, item.id)) {
      throw new HttpError(409, 'Tienes una aclaración pendiente de este recibo: espera la respuesta antes de firmar', 'CLAIM_PENDING');
    }
    await db.query(
      `INSERT INTO payroll_receipt_signatures (restaurant_id, item_id, employee_id, user_id, net_at_signing, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.tenant.id, item.id, emp.id, req.user.id, item.net, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)],
    );
    return myReceipt(db, req, item.id);
  });
  res.status(201).json({ item: data.item, period: data.period });
}));

export default router;
