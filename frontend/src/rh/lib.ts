// Utilidades de RH en el frontend: etiquetas, fechas en la zona horaria de
// la sucursal, permisos (los mismos que valida el backend) y descarga de
// archivos con la sesion.
import { ApiError } from '../lib/api';
import { session } from '../lib/session';
import type { Role } from '../lib/types';
import type { DayStatus, Frequency, PeriodStatus } from './types';

export const DOW_LABEL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const DOW_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const FREQUENCY_LABEL: Record<Frequency, string> = { semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };
export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = { borrador: 'Borrador', aprobada: 'Aprobada', cerrada: 'Cerrada' };
export const PERIOD_STATUS_STYLE: Record<PeriodStatus, string> = {
  borrador: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  aprobada: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  cerrada: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
};
export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  trabajado: 'Trabajó',
  falta: 'Falta',
  falta_justificada: 'Falta justificada',
  descanso: 'Descanso',
  festivo: 'Festivo',
  pendiente: 'Pendiente',
  fuera_de_contrato: 'Sin contrato',
};
export const DAY_STATUS_STYLE: Record<DayStatus, string> = {
  trabajado: 'text-emerald-300',
  falta: 'text-red-300',
  falta_justificada: 'text-sky-300',
  descanso: 'text-gray-500',
  festivo: 'text-violet-300',
  pendiente: 'text-gray-600',
  fuera_de_contrato: 'text-gray-600',
};
export const PAY_METHOD_LABEL = { caja: 'Caja (POS)', efectivo: 'Efectivo', transferencia: 'Transferencia', otro: 'Otro' } as const;
export const ADJUSTMENT_KIND_LABEL = { bono: 'Bono', descuento: 'Descuento', prestamo: 'Préstamo' } as const;
export const MONTH_LABEL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const can = (roles: Role[]) => (role: Role) => roles.includes(role);
export const rhCan = {
  manage: can(['admin', 'gerente']),
  admin: can(['admin']),
};

/** 'YYYY-MM-DD' de hoy (o con un desfase en dias) en la zona del navegador. */
export function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Fecha y hora de un instante en la zona horaria de la sucursal. */
export function inZone(iso: string, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export const hours = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
};

export const shortDay = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DOW_SHORT[dt.getDay()]} ${d}/${String(m).padStart(2, '0')}`;
};

/** Descarga un archivo de la API (CSV) con el token del restaurante. */
export async function downloadFile(path: string, filename: string) {
  const headers: Record<string, string> = {};
  const token = session.getToken('restaurant');
  if (token) headers.Authorization = `Bearer ${token}`;
  const slug = session.getDevSlug();
  if (slug) headers['X-Restaurant-Slug'] = slug;
  const res = await fetch(`/api${path}`, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error || `Error ${res.status}`, data?.code);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
