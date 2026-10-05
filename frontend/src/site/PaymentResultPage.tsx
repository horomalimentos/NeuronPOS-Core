import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import type { CustomerOrder, PaymentStart } from './types';

const POLL_MS = 3000;
const MAX_TRIES = 10;

/**
 * Regreso desde Clip (/pago/resultado?pedido=<token>&r=ok|error|cancelado).
 * Lo que diga la URL no se cree: se le pide al servidor que concilie con
 * Clip y se muestra lo que responda. Mientras siga pendiente se reintenta
 * cada 3 segundos (el webhook puede tardar un poco).
 */
export default function PaymentResultPage() {
  const [params] = useSearchParams();
  const token = params.get('pedido') || '';
  const hint = params.get('r');
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);
  const [paying, setPaying] = useState(false);
  const stop = useRef(false);

  const verify = useCallback(() => {
    if (!token) return Promise.resolve();
    return portalApi<{ order: CustomerOrder }>(`/portal/track/${encodeURIComponent(token)}/verify-payment`, { method: 'POST', noRedirect: true })
      .then((r) => {
        setOrder(r.order);
        setError('');
        if (r.order.online_payment_status !== 'pendiente') stop.current = true;
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setTries((n) => n + 1));
  }, [token]);

  // Reintenta cada 3 s mientras siga pendiente (hasta MAX_TRIES).
  useEffect(() => {
    if (tries === 0) {
      void verify();
      return undefined;
    }
    if (stop.current || tries >= MAX_TRIES) return undefined;
    const t = setTimeout(() => { void verify(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [tries, verify]);

  async function retry() {
    setPaying(true);
    try {
      const r = await portalApi<{ payment: PaymentStart }>(`/portal/track/${encodeURIComponent(token)}/pay`, { method: 'POST', noRedirect: true });
      if (r.payment.action === 'redirect' && r.payment.url) {
        window.location.assign(r.payment.url);
        return;
      }
      void verify();
    } catch (e) {
      setError(errorMessage(e));
    }
    setPaying(false);
  }

  if (!token) return <p className="px-6 py-24 text-center text-gray-500">No encontramos el pedido de este pago.</p>;
  if (!order) {
    return error ? <p className="px-6 py-24 text-center text-gray-500">{error}</p>
      : <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const status = order.online_payment_status;
  const paid = status === 'pagado';
  const cancelled = status === 'cancelado' || order.status === 'cancelado' || order.status === 'rechazado';
  const pending = !paid && !cancelled;
  const stillChecking = pending && tries < MAX_TRIES && !stop.current;

  let icon = <Clock className="h-12 w-12 text-violet-500" />;
  let title = 'Estamos confirmando tu pago';
  let text = 'Clip aún no nos confirma el pago. Esto puede tardar unos segundos.';
  if (paid) {
    icon = <CheckCircle2 className="h-12 w-12 text-emerald-500" />;
    title = '¡Pago recibido!';
    text = 'Tu pedido ya le llegó al restaurante.';
  } else if (cancelled) {
    icon = <XCircle className="h-12 w-12 text-red-500" />;
    title = 'Pedido cancelado';
    text = 'El pedido se canceló y no se completó el pago.';
  } else if (!stillChecking && hint === 'cancelado') {
    icon = <XCircle className="h-12 w-12 text-amber-500" />;
    title = 'No se completó el pago';
    text = 'Cancelaste el pago en Clip. Puedes intentarlo de nuevo mientras el pedido siga vigente.';
  } else if (!stillChecking && hint === 'error') {
    icon = <XCircle className="h-12 w-12 text-red-500" />;
    title = 'El pago no pasó';
    text = 'Clip no pudo cobrar. Puedes intentarlo de nuevo con otra tarjeta.';
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <div className="card-light p-6 text-center">
        <div className="flex justify-center">{icon}</div>
        <h1 className="mt-3 text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{text}</p>
        <p className="mt-3 text-sm text-gray-500">Pedido #{order.folio} · {formatMXN(order.total)}</p>
        {stillChecking && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-gray-400"><Loader2 className="h-3 w-3 animate-spin" /> Verificando con Clip…</p>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex flex-col gap-2">
          {pending && !stillChecking && (
            <button className="btn-brand" onClick={retry} disabled={paying}>
              {paying && <Loader2 className="h-4 w-4 animate-spin" />} Intentar pagar de nuevo
            </button>
          )}
          {pending && !stillChecking && (
            <button className="btn-outline" onClick={() => { stop.current = false; setTries(0); }}>Ya pagué, volver a verificar</button>
          )}
          <Link to={`/pedido/${encodeURIComponent(token)}`} className={paid ? 'btn-brand' : 'btn-outline'}>Ver mi pedido</Link>
        </div>
      </div>
    </div>
  );
}
