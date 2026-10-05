// Textos de horario para el sitio y el portal (el calculo de abierto/cerrado
// lo hace el servidor en la zona horaria de la sucursal).
import type { BranchHours, PublicBranch } from '../lib/types';

export const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
// Para mostrar la semana empezando en lunes.
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const hoursRange = (h: { opens_at: string; closes_at: string }) =>
  (h.opens_at === h.closes_at ? 'Abierto 24 horas' : `${h.opens_at} – ${h.closes_at}`);

/** Lunes a domingo con su horario o "Cerrado". */
export function weekSchedule(hours: BranchHours[]) {
  return WEEK_ORDER.map((d) => {
    const h = hours.find((x) => x.weekday === d);
    return { day: WEEKDAYS[d], text: h ? hoursRange(h) : 'Cerrado' };
  });
}

/** "Abierto · cierra 22:00", "Cerrado hoy", "Abre hoy 13:00 – 22:00"... */
export function openLabel(b: Pick<PublicBranch, 'open_now' | 'today' | 'closed_today' | 'hours'>) {
  if (!b.hours.length) return 'Horario no disponible';
  if (b.open_now) return b.today && b.today.opens_at !== b.today.closes_at ? `Abierto · cierra ${b.today.closes_at}` : 'Abierto ahora';
  if (b.closed_today) return 'Cerrado hoy';
  return b.today ? `Cerrado · hoy ${hoursRange(b.today)}` : 'Cerrado hoy';
}
