// Utilidades del portal de clientes (sin componentes).
import type { CustomerStatus, PortalConfig } from './types';

/** Sucursal del carrito si recibe pedidos; si no, la primera abierta que los reciba. */
export function pickBranch(config: PortalConfig, current: string | null) {
  const usable = config.branches.filter((b) => b.accepts_orders);
  return (usable.find((b) => b.id === current) || usable.find((b) => b.open_now) || usable[0] || config.branches[0])?.id || null;
}

export const STATUS_STYLE: Record<CustomerStatus, string> = {
  esperando_pago: 'bg-violet-100 text-violet-800',
  recibido: 'bg-sky-100 text-sky-800',
  preparando: 'bg-amber-100 text-amber-800',
  listo: 'bg-emerald-100 text-emerald-800',
  en_camino: 'bg-indigo-100 text-indigo-800',
  entregado: 'bg-gray-200 text-gray-700',
  rechazado: 'bg-red-100 text-red-800',
  cancelado: 'bg-red-100 text-red-800',
};

/** Estados finales: el seguimiento deja de consultar al servidor. */
export const isFinal = (s: CustomerStatus) => ['entregado', 'rechazado', 'cancelado'].includes(s);

export const formatTimeShort = (iso: string | null | undefined) =>
  (iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '');

export const formatDateTimeShort = (iso: string | null | undefined) =>
  (iso ? new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
