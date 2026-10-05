import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { STATUS_LABEL } from '../lib/format';
import type { RestaurantStatus } from '../lib/types';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-brand-contrast hover:bg-brand/90',
  secondary: 'bg-gray-800 text-gray-100 hover:bg-gray-700 border border-gray-700',
  danger: 'bg-red-700 text-white hover:bg-red-600',
  ghost: 'text-gray-300 hover:bg-gray-800',
};

export function Button({
  variant = 'primary', loading, className = '', children, disabled, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold
        transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'success' | 'warning'; children: ReactNode }) {
  const styles = {
    error: 'bg-red-950/50 border-red-800 text-red-300',
    success: 'bg-emerald-950/50 border-emerald-800 text-emerald-300',
    warning: 'bg-amber-950/50 border-amber-700 text-amber-200',
  }[kind];
  const Icon = kind === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${styles}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
      <Loader2 className="h-5 w-5 animate-spin" /> {label}
    </div>
  );
}

const STATUS_STYLE: Record<RestaurantStatus, string> = {
  active: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  trial: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  suspended: 'bg-red-500/15 text-red-300 ring-red-500/30',
};

export function StatusBadge({ status }: { status: RestaurantStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-50
        ${checked ? 'bg-emerald-500' : 'bg-gray-700'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:items-center">
      <div className={`card my-8 w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} shadow-2xl`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
