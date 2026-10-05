// Dias de descanso obligatorio en Mexico (Ley Federal del Trabajo, art. 74),
// calculados por regla para cualquier anio (igual que mx_official_holiday()
// en 007_rh_nomina.sql):
//   1 ene; primer lunes de febrero; tercer lunes de marzo; 1 may; 16 sep;
//   tercer lunes de noviembre; 25 dic; 1 oct cada seis anios (2024, 2030...).
import { ymd } from './dates.js';

function nthMonday(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (8 - (first === 0 ? 7 : first)) % 7; // dias hasta el primer lunes
  return ymd(year, month, 1 + offset + (n - 1) * 7);
}

/** [{ date, name }] de un anio, en orden. */
export function mexicanHolidays(year) {
  const list = [
    { date: ymd(year, 1, 1), name: 'Año Nuevo' },
    { date: nthMonday(year, 2, 1), name: 'Día de la Constitución' },
    { date: nthMonday(year, 3, 3), name: 'Natalicio de Benito Juárez' },
    { date: ymd(year, 5, 1), name: 'Día del Trabajo' },
    { date: ymd(year, 9, 16), name: 'Día de la Independencia' },
    { date: nthMonday(year, 11, 3), name: 'Día de la Revolución' },
    { date: ymd(year, 12, 25), name: 'Navidad' },
  ];
  if ((year - 2024) % 6 === 0) list.push({ date: ymd(year, 10, 1), name: 'Transmisión del Poder Ejecutivo Federal' });
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Mapa fecha -> nombre de los festivos entre dos fechas: los oficiales (si
 * el restaurante los usa) mas los adicionales del restaurante.
 */
export function holidaysBetween(from, to, { official = true, custom = [] } = {}) {
  const map = new Map();
  if (official) {
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
      for (const h of mexicanHolidays(y)) if (h.date >= from && h.date <= to) map.set(h.date, h.name);
    }
  }
  for (const h of custom) {
    const date = typeof h.date === 'string' ? h.date.slice(0, 10) : h.date;
    if (date >= from && date <= to) map.set(date, h.name);
  }
  return map;
}
