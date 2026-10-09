import type { CountStatus, InvProduct, MovementKind, PoStatus } from './types';

const can = (roles: string[]) => (role: string) => roles.includes(role);

/** Igual que INV_ROLES del backend. */
export const invCan = {
  manage: can(['admin', 'gerente']),
  staff: can(['admin', 'gerente', 'cajero', 'cocina']),
};

export const KIND_LABEL: Record<MovementKind, string> = {
  conteo: 'Conteo', compra: 'Compra', venta: 'Venta', cancelacion: 'Cancelación', merma: 'Merma', ajuste: 'Ajuste',
};

export const COUNT_STATUS_LABEL: Record<CountStatus, string> = {
  en_progreso: 'En progreso', pausado: 'Pausado', completado: 'Completado', cancelado: 'Cancelado',
};

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  solicitada: 'Solicitada', aprobada: 'Aprobada', recibida: 'Recibida', cancelada: 'Cancelada',
};

export const PO_STATUS_STYLE: Record<PoStatus, string> = {
  solicitada: 'bg-amber-500/15 text-amber-200 ring-amber-500/30',
  aprobada: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  recibida: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  cancelada: 'bg-gray-500/15 text-gray-400 ring-gray-500/30',
};

export const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/** Cantidad legible: hasta 3 decimales, sin ceros de mas. */
export const fmtQty = (v: number | string | null | undefined) =>
  Number(v || 0).toLocaleString('es-MX', { maximumFractionDigits: 3 });

/** Unidades en que se puede capturar un insumo (la base primero). */
export const unitOptions = (p: Pick<InvProduct, 'base_unit' | 'units'>) =>
  [{ name: p.base_unit, factor: 1 }, ...p.units.map((u) => ({ name: u.name, factor: Number(u.factor) }))];

/** Fecha local AAAA-MM-DD del dispositivo. */
export const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Liga de WhatsApp con el texto (al numero del proveedor si lo tiene). */
export function whatsappLink(phone: string | null, text: string) {
  const digits = (phone || '').replace(/\D/g, '');
  const to = digits.length === 10 ? `52${digits}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
