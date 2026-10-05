// Fechas de calendario ('YYYY-MM-DD') y hora local de una sucursal. Todo es
// puro: las fechas se manejan como texto y se operan en UTC para que la zona
// horaria del servidor nunca mueva un dia.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateStr(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const toUtc = (s) => new Date(`${s}T00:00:00Z`);
const fromUtc = (d) => d.toISOString().slice(0, 10);

export function addDays(dateStr, n) {
  const d = toUtc(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** 0 = domingo ... 6 = sabado. */
export const dayOfWeek = (dateStr) => toUtc(dateStr).getUTCDay();

export function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

/** Lista de fechas de from a to (incluidas). */
export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function monthRange(year, month) {
  return { start: ymd(year, month, 1), end: ymd(year, month, lastDayOfMonth(year, month)) };
}

/** 'HH:MM' o 'HH:MM:SS' -> minutos desde medianoche. */
export function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

export const minutesToTime = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatters.get(timeZone);
}

/** Fecha y minuto del dia de un instante en la zona horaria dada. */
export function localParts(instant, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Fecha local de hoy en una zona horaria. */
export const localToday = (timeZone, now = new Date()) => localParts(now, timeZone).date;

/**
 * Instante (Date) que corresponde a una fecha y hora local de una zona.
 * Se ajusta con el desfase de la zona en ese momento (sirve con horario de
 * verano porque se corrige dos veces).
 */
export function zonedTimeToUtc(dateStr, time, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const mins = timeToMinutes(time);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60);
  let ts = guess;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(ts, timeZone);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const asUtc = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    ts += guess - asUtc;
  }
  return new Date(ts);
}
