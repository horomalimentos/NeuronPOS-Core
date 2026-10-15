// Apartados de dinero (modulo "apartados"): calculo de cuotas, en centavos.
// Funciones puras, sin base de datos.
import { addDays, dayOfWeek, daysBetween, lastDayOfMonth, ymd } from './rh/dates.js';
import { fromCents, toCents } from './posMath.js';

export const FREQUENCIES = ['diaria', 'semanal', 'quincenal', 'mensual'];
// Tope de cuotas por apartado (un plan diario de un año y algo).
export const MAX_INSTALLMENTS = 400;

/** Dia de la semana ISO (1 = lunes ... 7 = domingo) de AAAA-MM-DD. */
const isoWeekday = (date) => dayOfWeek(date) || 7;

/** Mismo dia del mes, n meses despues (el 31 cae en el ultimo dia si el mes es corto). */
function addMonthsClamped(date, n, day) {
  const [y, m] = date.split('-').map(Number);
  const total = (m - 1) + n;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  return ymd(year, month, Math.min(day, lastDayOfMonth(year, month)));
}

/** Fechas de las cuotas entre from y due (ambas incluidas). */
export function installmentDates({ frequency, from, due, weekdays = [1, 2, 3, 4, 5, 6] }) {
  if (!frequency || !due || due < from) return [];
  const dates = [];
  const push = (d) => {
    dates.push(d);
    if (dates.length > MAX_INSTALLMENTS) throw new RangeError('demasiadas cuotas');
  };
  if (frequency === 'diaria') {
    const days = new Set(weekdays.map(Number));
    for (let i = 0, d = from; d <= due; i += 1, d = addDays(from, i)) {
      if (days.has(isoWeekday(d))) push(d);
    }
  } else if (frequency === 'semanal' || frequency === 'quincenal') {
    const step = frequency === 'semanal' ? 7 : 14;
    for (let d = from; d <= due; d = addDays(d, step)) push(d);
  } else if (frequency === 'mensual') {
    const day = Number(from.slice(8, 10));
    for (let i = 0, d = from; d <= due; i += 1, d = addMonthsClamped(from, i, day)) push(d);
  }
  return dates;
}

/**
 * Reparte lo que falta en cuotas iguales: los centavos que sobran van en las
 * primeras para que la suma sea exacta. Devuelve [{ due_on, amount }].
 */
export function planInstallments({ remaining, ...plan }) {
  const cents = toCents(remaining);
  if (cents <= 0) return [];
  const dates = installmentDates(plan);
  if (!dates.length) return [];
  const base = Math.floor(cents / dates.length);
  const extra = cents - base * dates.length;
  return dates
    .map((due_on, i) => ({ due_on, amount: fromCents(base + (i < extra ? 1 : 0)) }))
    .filter((x) => x.amount > 0);
}

/** Saldo de un apartado: depositos menos retiros. */
export function balanceOf(movements) {
  return fromCents(movements.reduce((sum, m) => sum + (m.kind === 'retiro' ? -1 : 1) * toCents(m.amount), 0));
}

/** Fecha limite del aguinaldo (LFT art. 87: antes del 20 de diciembre). */
export const aguinaldoDueDate = (year) => `${year}-12-20`;

/** Dias que faltan para una fecha (0 si ya paso). */
export const daysLeft = (today, due) => (due && due > today ? daysBetween(today, due) : 0);
