// Pedidos programados (modulo 'pedidos_programados'), adaptado de Horom
// (webOrders.js scheduled_time + jobs/scheduledOrderDispatcher.js).
//
// Los horarios disponibles se calculan como instantes cada 15 min: desde
// ahora + anticipacion minima hasta el ultimo dia permitido, solo los que
// caen con la sucursal abierta (horario semanal y dias cerrados, en su zona
// horaria). El cliente manda uno de esos instantes. Funciones puras; el job
// que los manda a cocina esta en scheduledOrders.js.
import { isOpenAt, localParts } from './hours.js';
import { badRequest } from '../utils/http.js';

const STEP_MS = 15 * 60 * 1000;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parts(date, tz) {
  try {
    return localParts(date, tz);
  } catch {
    return localParts(date, 'UTC');
  }
}

function dayLabel(ymd, today, tz, at) {
  if (ymd === today) return 'Hoy';
  if (ymd === addDays(today, 1)) return 'Mañana';
  return new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(at);
}

const timeLabel = (at, tz) => new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(at);

/**
 * Horarios para programar: [{ date, label, times: [{ at (ISO), label }] }].
 * branch: { hours, closures: [{closed_on}] | ['YYYY-MM-DD'], timezone }
 */
export function scheduleSlots(branch, settings, now = new Date()) {
  const tz = branch.timezone;
  const closures = (branch.closures || []).map((c) => (typeof c === 'string' ? c : c.closed_on));
  const today = parts(now, tz).date;
  const lastDay = addDays(today, settings.schedule_max_days);
  const start = Math.ceil((now.getTime() + settings.schedule_min_lead_minutes * 60000) / STEP_MS) * STEP_MS;
  const end = now.getTime() + (settings.schedule_max_days + 2) * 24 * 3600 * 1000;
  const days = new Map();
  for (let t = start; t <= end; t += STEP_MS) {
    const at = new Date(t);
    const p = parts(at, tz);
    if (p.date > lastDay) break;
    if (!isOpenAt(branch.hours, closures, p).open) continue;
    if (!days.has(p.date)) days.set(p.date, { date: p.date, label: dayLabel(p.date, today, tz, at), times: [] });
    days.get(p.date).times.push({ at: at.toISOString(), label: timeLabel(at, tz) });
  }
  return [...days.values()];
}

/** Valida la hora que mando el cliente. Regresa Date o lanza 400. */
export function readScheduledFor(value, branch, settings, now = new Date()) {
  const at = new Date(String(value || ''));
  if (Number.isNaN(at.getTime())) throw badRequest('Elige una hora válida para tu pedido', 'INVALID_SCHEDULE');
  const t = at.getTime();
  // Margen de 2 min por si el cliente tardo en confirmar.
  if (t % STEP_MS !== 0 || t < now.getTime() + (settings.schedule_min_lead_minutes - 2) * 60000) {
    throw badRequest(`Programa tu pedido con al menos ${settings.schedule_min_lead_minutes} minutos de anticipación`, 'INVALID_SCHEDULE');
  }
  const tz = branch.timezone;
  const p = parts(at, tz);
  if (p.date > addDays(parts(now, tz).date, settings.schedule_max_days)) {
    throw badRequest(`Solo puedes programar hasta ${settings.schedule_max_days} días después`, 'INVALID_SCHEDULE');
  }
  const closures = (branch.closures || []).map((c) => (typeof c === 'string' ? c : c.closed_on));
  if (!isOpenAt(branch.hours, closures, p).open) {
    throw badRequest('La sucursal está cerrada a esa hora; elige otra', 'INVALID_SCHEDULE');
  }
  return at;
}
