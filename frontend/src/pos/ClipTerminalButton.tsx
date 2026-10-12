import { CheckCircle2, CreditCard, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';

export interface ClipCobro {
  id: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  amount: number;
  card_last_digits: string | null;
  card_brand: string | null;
  error_message: string | null;
}

/**
 * Cobrar una linea con la terminal Clip de esta caja (como el PinPad de
 * Horom): enciende la terminal con el monto, pregunta el resultado cada 2
 * segundos y, ya aprobado, la linea se registra como pago con tarjeta.
 */
export default function ClipTerminalButton({ orderId, amount, terminal, onApproved, onReset }: {
  orderId: string; amount: number; terminal: string;
  onApproved: (cobro: ClipCobro) => void; onReset: () => void;
}) {
  const [cobro, setCobro] = useState<ClipCobro | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const track = (c: ClipCobro) => {
    setCobro(c);
    if (c.status === 'COMPLETED') { onApproved(c); return; }
    if (c.status !== 'PENDING') return;
    timer.current = window.setTimeout(() => {
      api<{ cobro: ClipCobro }>(`/pos/clip/cobros/${c.id}`).then((r) => track(r.cobro)).catch((e) => setError(errorMessage(e)));
    }, 2000);
  };

  async function start() {
    setBusy(true);
    setError('');
    onReset();
    try {
      const r = await api<{ cobro: ClipCobro }>('/pos/clip/cobros', { method: 'POST', body: { order_id: orderId, amount, terminal } });
      track(r.cobro);
    } catch (err) {
      // Ya habia un cobro aprobado sin registrar: se usa ese.
      const prev = err instanceof ApiError && err.code === 'PINPAD_ALREADY_APPROVED'
        ? (err.data?.cobro as ClipCobro | undefined) : undefined;
      if (prev) track(prev);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!cobro) return;
    window.clearTimeout(timer.current);
    try {
      const r = await api<{ cobro: ClipCobro }>(`/pos/clip/cobros/${cobro.id}`, { method: 'DELETE' });
      setCobro(r.cobro);
    } catch (err) {
      setError(errorMessage(err));
      track(cobro);
    }
  }

  if (cobro?.status === 'COMPLETED') {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-300">
        <CheckCircle2 className="h-4 w-4" /> Aprobado en la terminal · {cobro.card_brand || 'Tarjeta'} ****{cobro.card_last_digits} · {formatMXN(cobro.amount)}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {cobro?.status === 'PENDING' ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
          <Loader2 className="h-4 w-4 animate-spin text-brand" /> Esperando la tarjeta en la terminal ({formatMXN(cobro.amount)})…
          <button type="button" className="text-red-300 hover:underline" onClick={cancel}>Cancelar</button>
        </div>
      ) : (
        <button type="button" disabled={busy || !(amount > 0)} onClick={start}
          className="flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm font-semibold text-sky-200 hover:bg-sky-500/20 disabled:opacity-50">
          <CreditCard className="h-4 w-4" /> Cobrar {formatMXN(amount)} en terminal Clip
        </button>
      )}
      {cobro && (cobro.status === 'FAILED' || cobro.status === 'CANCELLED') && (
        <p className="flex items-center gap-1.5 text-sm text-red-300"><XCircle className="h-4 w-4" />{cobro.status === 'CANCELLED' ? 'Cobro cancelado.' : cobro.error_message || 'La terminal no aprobó el cobro.'}</p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}
