// Utilidades del POS en el frontend: etiquetas, sucursal y terminal elegidas
// (localStorage, por dispositivo) y permisos por rol (los mismos que valida
// el backend en routes/pos/common.js).
import type { Role } from '../lib/types';
import type { MethodKind, OrderStatus, OrderType } from './types';

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  comedor: 'Comedor',
  para_llevar: 'Para llevar',
  domicilio: 'Domicilio',
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  abierta: 'Abierta',
  enviada: 'En cocina',
  lista: 'Lista',
  pagada: 'Pagada',
  cancelada: 'Cancelada',
};

export const ORDER_STATUS_STYLE: Record<OrderStatus, string> = {
  abierta: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  enviada: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  lista: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  pagada: 'bg-gray-500/15 text-gray-300 ring-gray-500/30',
  cancelada: 'bg-red-500/15 text-red-300 ring-red-500/30',
};

export const METHOD_KIND_LABEL: Record<MethodKind, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  otro: 'Otro',
  en_linea: 'En línea (Clip)',
  puntos: 'Puntos de lealtad',
};

/** Tipos que se pueden elegir al crear o editar un método (el de Clip lo pone el sistema). */
export const EDITABLE_METHOD_KINDS: MethodKind[] = ['efectivo', 'tarjeta', 'transferencia', 'otro'];

const can = (roles: Role[]) => (role: Role) => roles.includes(role);
export const posCan = {
  manage: can(['admin', 'gerente']),
  orders: can(['admin', 'gerente', 'cajero', 'mesero']),
  cashier: can(['admin', 'gerente', 'cajero']),
  kitchen: can(['admin', 'gerente', 'cajero', 'mesero', 'cocina']),
  kitchenReady: can(['admin', 'gerente', 'cocina']),
};

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* almacenamiento bloqueado */ }
}

export const posPrefs = {
  getBranch: () => read('npc_pos_branch'),
  setBranch: (id: string) => write('npc_pos_branch', id),
  getTerminal: () => read('npc_pos_terminal') || 'Caja 1',
  setTerminal: (name: string) => write('npc_pos_terminal', name),
};

export const num = (v: unknown) => Number(v || 0);
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minutos transcurridos desde una fecha (para la pantalla de cocina). */
export const minutesSince = (iso: string | null | undefined, now = Date.now()) =>
  iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000)) : 0;

export const formatTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
