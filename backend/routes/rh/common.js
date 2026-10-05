// Utilidades de las rutas de recursos humanos.
import { requireRole } from '../../middleware/auth.js';
import { isDateStr, daysBetween, zonedTimeToUtc } from '../../services/rh/dates.js';
import { HttpError, badRequest } from '../../utils/http.js';

// Gestion de RH (empleados, checadas, nomina): admin y gerente.
export const manager = requireRole('admin', 'gerente');
// Configuracion de nomina, aprobar y cerrar periodos: solo admin.
export const adminOnly = requireRole('admin');

/** Rango de fechas ?from&to (AAAA-MM-DD) con un maximo de dias. */
export function readRange(query, { maxDays = 62, defaultFrom, defaultTo } = {}) {
  const from = query.from || defaultFrom;
  const to = query.to || defaultTo;
  if (!isDateStr(from) || !isDateStr(to)) throw badRequest('Indica from y to con formato AAAA-MM-DD', 'INVALID_RANGE');
  if (to < from) throw badRequest('La fecha final es anterior a la inicial', 'INVALID_RANGE');
  if (daysBetween(from, to) > maxDays) throw badRequest(`El rango no puede pasar de ${maxDays} días`, 'INVALID_RANGE');
  return { from, to };
}

/**
 * Instante de una checada manual: date + time (hora local de la sucursal del
 * empleado) u occurred_at (ISO).
 */
export function readInstant(body, timeZone) {
  if (body.date !== undefined || body.time !== undefined) {
    if (!isDateStr(body.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) {
      throw badRequest('Indica fecha (AAAA-MM-DD) y hora (HH:MM)', 'INVALID_FIELD');
    }
    return zonedTimeToUtc(body.date, body.time, timeZone);
  }
  const d = new Date(body.occurred_at);
  if (!body.occurred_at || Number.isNaN(d.getTime())) throw badRequest('Fecha y hora inválidas', 'INVALID_FIELD');
  return d;
}

/**
 * Un dia que ya esta en una nomina aprobada o cerrada no se puede corregir
 * (checadas ni justificaciones): primero se reabre el periodo.
 */
export async function assertDayEditable(db, restaurantId, employeeId, date) {
  const { rows } = await db.query(
    `SELECT p.status FROM payroll_items i
       JOIN payroll_periods p ON p.id = i.period_id AND p.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.employee_id = $2 AND p.status <> 'borrador'
        AND $3::date BETWEEN p.start_date AND p.end_date
      LIMIT 1`,
    [restaurantId, employeeId, date],
  );
  if (rows[0]) {
    throw new HttpError(409, 'Ese día ya está en una nómina aprobada o cerrada; reábrela para corregirlo', 'PERIOD_LOCKED');
  }
}
