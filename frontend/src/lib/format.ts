const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
export const formatMXN = (v: number | string | null | undefined) => mxn.format(Number(v || 0));

export const formatDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Para <input type="date">: YYYY-MM-DD o vacio. */
export const toDateInput = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '');

export const STATUS_LABEL = { active: 'Activo', trial: 'Prueba', suspended: 'Suspendido' } as const;

export const ROLE_LABEL = {
  admin: 'Administrador',
  gerente: 'Gerente',
  cajero: 'Cajero',
  mesero: 'Mesero',
  cocina: 'Cocina',
  repartidor: 'Repartidor',
} as const;

export const INVOICE_STATUS_LABEL = { pending: 'Pendiente', overdue: 'Vencida', paid: 'Pagada', void: 'Cancelada' } as const;
export const INVOICE_STATUS_STYLE = {
  pending: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  overdue: 'bg-red-500/15 text-red-300 ring-red-500/30',
  paid: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  void: 'bg-gray-500/15 text-gray-300 ring-gray-500/30',
} as const;
export const PAID_METHOD_LABEL = { clip: 'Clip', manual: 'Manual', sin_cargo: 'Sin cargo' } as const;

/** Fecha de calendario 'YYYY-MM-DD' sin correrse por la zona horaria del navegador. */
export const formatDay = (v: string | null | undefined) => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
};
