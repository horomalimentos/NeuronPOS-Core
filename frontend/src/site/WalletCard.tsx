import { Loader2, PiggyBank } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { Notice } from './OrderPage';
import { formatDateTimeShort } from './portalLib';

interface WalletView {
  enabled: boolean;
  settings?: { topups_available: boolean; min_topup: number; max_topup: number; suggested_amounts: number[]; max_balance: number; web_enabled: boolean };
  balance?: number;
  transactions?: { kind: string; amount: string; balance_after: string; reason: string | null; created_at: string }[];
}

const KIND = { topup: 'Recarga', purchase: 'Pago', refund: 'Devolución', adjust: 'Ajuste' } as Record<string, string>;

/**
 * Monedero en "Mi cuenta": saldo, recarga con tarjeta (Clip del restaurante)
 * y movimientos. Al volver de Clip (?recarga=ok) se concilia con Clip.
 */
export default function WalletCard() {
  const [params, setParams] = useSearchParams();
  const back = params.get('recarga');
  const [data, setData] = useState<WalletView | null>(null);
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (back) {
        const r = await portalApi<WalletView>('/portal/me/wallet/verify', { method: 'POST' });
        setData(r);
        if (back === 'ok') setMsg({ kind: 'warning', text: 'Recarga recibida. Si aún no ves tu saldo, espera unos segundos y recarga la página.' });
        else setMsg({ kind: 'warning', text: 'La recarga no se completó.' });
        setParams((p) => { p.delete('recarga'); return p; }, { replace: true });
      } else {
        setData(await portalApi<WalletView>('/portal/me/wallet'));
      }
    } catch (e) { setMsg({ kind: 'error', text: errorMessage(e) }); }
  }, [back, setParams]);
  useEffect(() => { void load(); }, [load]);

  const topup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await portalApi<{ payment: { url: string } }>('/portal/me/wallet/topup', { method: 'POST', body: { amount: Number(amount) } });
      window.location.assign(r.payment.url);
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
      setBusy(false);
    }
  };

  if (!data?.enabled || !data.settings) return msg?.kind === 'error' ? <Notice kind="error">{msg.text}</Notice> : null;
  const s = data.settings;
  const balance = data.balance ?? 0;
  return (
    <section className="card-light space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-bold"><PiggyBank className="h-5 w-5 text-brand" /> Mi monedero</h2>
        <span className="text-3xl font-bold tabular-nums">{formatMXN(balance)}</span>
      </div>
      <p className="text-sm text-gray-500">
        Paga con tu saldo en caja (dictas tu código){s.web_enabled ? ' o en tus pedidos en línea' : ''}.
      </p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {s.topups_available ? (
        <form onSubmit={topup} className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {s.suggested_amounts.filter((a) => a >= s.min_topup && a <= s.max_topup).map((a) => (
              <button key={a} type="button" onClick={() => setAmount(String(a))}
                className={`rounded-xl border px-4 py-2 font-semibold ${Number(amount) === a ? 'border-brand bg-brand/10 text-brand' : 'border-gray-200 text-gray-700 hover:border-brand/50'}`}>
                {formatMXN(a)}
              </button>
            ))}
          </div>
          <label className="block"><span className="label-light">Monto a recargar ({formatMXN(s.min_topup)} a {formatMXN(s.max_topup)})</span>
            <span className="flex flex-wrap gap-2">
              <input className="input-light min-w-[8rem] flex-1" type="number" inputMode="decimal" min={s.min_topup} max={s.max_topup} step="1" required
                value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Otro monto" />
              <button type="submit" className="btn-brand" disabled={busy || !amount}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Recargar con tarjeta
              </button>
            </span>
          </label>
          <p className="text-xs text-gray-500">Pagas en la página segura de Clip. El saldo no se devuelve en efectivo.</p>
        </form>
      ) : (
        <p className="text-sm text-gray-500">Para recargar, pide en caja que te abonen o espera a que el restaurante active las recargas en línea.</p>
      )}
      {data.transactions && data.transactions.length > 0 && (
        <ul className="divide-y divide-gray-100 text-sm">
          {data.transactions.slice(0, 8).map((t, i) => (
            <li key={i} className="flex justify-between gap-2 py-2">
              <span>{KIND[t.kind] || t.kind}<span className="block text-xs text-gray-500">{formatDateTimeShort(t.created_at)}{t.reason ? ` · ${t.reason}` : ''}</span></span>
              <span className={`tabular-nums ${Number(t.amount) < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                {Number(t.amount) > 0 ? '+' : '−'}{formatMXN(Math.abs(Number(t.amount)))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
