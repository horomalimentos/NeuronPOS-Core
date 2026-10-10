import { Gift, KeyRound, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTimeShort } from './portalLib';

interface Code { code: string; expires_at: string; seconds_left: number }
interface Loyalty {
  enabled: boolean;
  program?: { name: string; points_per_peso: number; peso_per_point: number; min_redeem_points: number; redeem_enabled: boolean; require_code: boolean };
  balance?: number;
  value?: number;
  code_locked?: boolean;
  code?: Code | null;
  transactions?: { kind: string; points: number; balance_after: number; reason: string | null; created_at: string }[];
}

const KIND = { earn: 'Compra', redeem: 'Canje', reverse: 'Devolución', adjust: 'Ajuste' } as Record<string, string>;

/**
 * Puntos del cliente en "Mi cuenta": saldo, historial y el codigo de 6
 * digitos que dicta en caja para canjear (cambia cada 5 minutos).
 */
export default function LoyaltyCard() {
  const [data, setData] = useState<Loyalty | null>(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(0);

  const load = useCallback(() => {
    portalApi<Loyalty>('/portal/me/loyalty').then((r) => { setData(r); setLeft(r.code?.seconds_left || 0); })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  // Cuenta regresiva; al vencer se pide el codigo nuevo.
  useEffect(() => {
    if (!data?.code) return undefined;
    const t = setInterval(() => setLeft((s) => {
      if (s <= 1) { load(); return 0; }
      return s - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [data?.code, load]);

  const reset = async () => {
    try {
      const r = await portalApi<{ code: Code }>('/portal/me/loyalty/reset-code', { method: 'POST' });
      setData((d) => d && { ...d, code: r.code, code_locked: false });
      setLeft(r.code.seconds_left);
    } catch (e) { setError(errorMessage(e)); }
  };

  if (error || !data?.enabled || !data.program) return null;
  const p = data.program;
  const showCode = p.redeem_enabled && p.require_code;
  return (
    <section className="card-light space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-bold"><Gift className="h-5 w-5 text-brand" /> {p.name}</h2>
        <span className="text-right">
          <span className="block text-3xl font-bold tabular-nums">{(data.balance ?? 0).toLocaleString('es-MX')}</span>
          <span className="text-sm text-gray-500">valen {formatMXN(data.value)}</span>
        </span>
      </div>
      <p className="text-sm text-gray-500">
        Ganas {p.points_per_peso.toLocaleString('es-MX', { maximumFractionDigits: 2 })} por cada $1 de tus compras (en el sitio o diciendo tu teléfono en caja).
        {p.redeem_enabled && ` Desde ${p.min_redeem_points} los puedes usar para pagar en caja.`}
      </p>
      {showCode && (
        <div className="rounded-2xl bg-gray-100 p-4 text-center">
          {data.code_locked ? (
            <>
              <p className="text-sm text-gray-600">Tu código se bloqueó por intentos equivocados.</p>
              <button type="button" className="btn-brand mt-3" onClick={reset}><RefreshCw className="h-4 w-4" /> Generar código nuevo</button>
            </>
          ) : data.code && (
            <>
              <p className="flex items-center justify-center gap-1 text-xs uppercase tracking-wider text-gray-500"><KeyRound className="h-3.5 w-3.5" /> Código para canjear en caja</p>
              <p className="my-1 font-mono text-4xl font-bold tracking-[0.3em] text-gray-900">{data.code.code}</p>
              <p className="text-xs text-gray-500">Cambia en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · díselo solo a quien te cobra</p>
            </>
          )}
        </div>
      )}
      {data.transactions && data.transactions.length > 0 && (
        <ul className="divide-y divide-gray-100 text-sm">
          {data.transactions.slice(0, 8).map((t, i) => (
            <li key={i} className="flex justify-between gap-2 py-2">
              <span>{KIND[t.kind] || t.kind}<span className="block text-xs text-gray-500">{formatDateTimeShort(t.created_at)}{t.reason ? ` · ${t.reason}` : ''}</span></span>
              <span className={`tabular-nums ${t.points < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{t.points > 0 ? '+' : ''}{t.points.toLocaleString('es-MX')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
