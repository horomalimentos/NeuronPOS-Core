import { Gift } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTimeShort } from './portalLib';

interface Loyalty {
  enabled: boolean;
  program?: { name: string; points_per_peso: number; peso_per_point: number; min_redeem_points: number; redeem_enabled: boolean; require_code: boolean };
  balance?: number;
  value?: number;
  transactions?: { kind: string; points: number; balance_after: number; reason: string | null; created_at: string }[];
}

const KIND = { earn: 'Compra', redeem: 'Canje', reverse: 'Devolución', adjust: 'Ajuste' } as Record<string, string>;

/** Puntos del cliente en "Mi cuenta": saldo e historial (el codigo de caja esta en CodeCard). */
export default function LoyaltyCard() {
  const [data, setData] = useState<Loyalty | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    portalApi<Loyalty>('/portal/me/loyalty').then(setData).catch((e) => setError(errorMessage(e)));
  }, []);

  if (error || !data?.enabled || !data.program) return null;
  const p = data.program;
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
