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
