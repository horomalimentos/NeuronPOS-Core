// Horarios de sucursal: abierto/cerrado en la zona horaria de la sucursal.
// Funciones puras (las pruebas les pasan la fecha); las rutas leen
// branch_hours y branch_closures y llaman a branchOpenState.
//
// Reglas (ver 005_sitio_portal.sql):
//   - Un horario por dia (0 = domingo). Sin horario ese dia = cerrado.
//   - opens < closes: normal. opens > closes: cierra despues de medianoche
//     (la madrugada cuenta como parte del dia anterior). opens = closes: 24 h.
//   - Un dia en branch_closures: cerrado todo ese dia (lo que sobre del
//     horario nocturno del dia anterior tambien se respeta como cerrado).

export const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const WEEKDAY_SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 'HH:MM' o 'HH:MM:SS' -> minutos desde medianoche. */
export function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 'HH:MM' normalizado (para la API). */
export const hhmm = (t) => {
  const m = toMinutes(t);
  return m === null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Dia de la semana, minutos y fecha local (YYYY-MM-DD) de `date` en `timeZone`. */
export function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    dow: WEEKDAY_SHORT[p.weekday],
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Fecha local del dia anterior (YYYY-MM-DD). */
function previousDate(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * hours: [{ weekday, opens_at, closes_at }]
 * closures: ['YYYY-MM-DD', ...] (fechas locales)
 * parts: resultado de localParts
 * Regresa { open, closes_at? } (closes_at = hora de cierre del turno vigente).
 */
export function isOpenAt(hours, closures, parts) {
  const closed = new Set((closures || []).map((c) => String(c).slice(0, 10)));
  const byDay = new Map((hours || []).map((h) => [Number(h.weekday), h]));
  const t = parts.minutes;

  if (!closed.has(parts.date)) {
    const today = byDay.get(parts.dow);
    if (today) {
      const o = toMinutes(today.opens_at);
      const c = toMinutes(today.closes_at);
      if (o === c) return { open: true, closes_at: null };
      if (o < c && t >= o && t < c) return { open: true, closes_at: hhmm(today.closes_at) };
      if (o > c && t >= o) return { open: true, closes_at: hhmm(today.closes_at) };
    }
  }
  // Madrugada: turno nocturno que empezo ayer.
  const yDate = previousDate(parts.date);
  const yesterday = byDay.get((parts.dow + 6) % 7);
  if (yesterday && !closed.has(yDate) && !closed.has(parts.date)) {
    const o = toMinutes(yesterday.opens_at);
    const c = toMinutes(yesterday.closes_at);
    if (o > c && t < c) return { open: true, closes_at: hhmm(yesterday.closes_at) };
  }
  return { open: false };
}

/**
 * Estado de una sucursal ahora: { open, timezone, today: { opens_at, closes_at } | null,
 * closed_today, closes_at }.
 */
export function branchOpenState({ hours, closures, timezone }, now = new Date()) {
  let parts;
  try {
    parts = localParts(now, timezone);
  } catch {
    parts = localParts(now, 'UTC');
  }
  const state = isOpenAt(hours, closures, parts);
  const today = (hours || []).find((h) => Number(h.weekday) === parts.dow);
  const closedToday = (closures || []).some((c) => String(c).slice(0, 10) === parts.date);
  return {
    open: state.open,
    closes_at: state.closes_at ?? null,
    closed_today: closedToday,
    today: today && !closedToday ? { opens_at: hhmm(today.opens_at), closes_at: hhmm(today.closes_at) } : null,
    local_date: parts.date,
  };
}

/** Normaliza el horario semanal que manda el admin. Lanza Error con mensaje en espanol. */
export function normalizeWeek(list) {
  if (!Array.isArray(list)) throw new Error('El horario debe ser una lista');
  const seen = new Set();
  return list.map((h) => {
    const weekday = Number(h?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Dia de la semana invalido');
    if (seen.has(weekday)) throw new Error(`${WEEKDAYS[weekday]} esta repetido`);
    seen.add(weekday);
    const opens = hhmm(h.opens_at);
    const closes = hhmm(h.closes_at);
    if (!opens || !closes) throw new Error(`Hora invalida el ${WEEKDAYS[weekday]} (usa HH:MM)`);
    return { weekday, opens_at: opens, closes_at: closes };
  }).sort((a, b) => a.weekday - b.weekday);
}
