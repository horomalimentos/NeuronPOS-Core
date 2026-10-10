import { ArrowLeft, Bike, Check, ChefHat, Clock, CreditCard, PackageCheck, Phone, Store, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';

type Status = 'pago_pendiente' | 'nuevo' | 'aceptado' | 'listo' | 'en_camino' | 'entregado' | 'rechazado' | 'cancelado';
interface Tracked {
  token: string; folio: number; status: Status; status_label: string; cancel_reason: string | null;
  restaurant: { name: string; logo_url: string | null; branch_name: string; address: string | null; phone: string | null };
  customer_name: string; address: string; reference: string | null;
  items: { name: string; quantity: number; notes: string | null; modifiers: string[]; line_total: number }[];
  food_total: string; delivery_fee: string; total: string; payment_method: string; pay_with: string | null;
  estimated_ready_at: string | null; created_at: string; accepted_at: string | null; ready_at: string | null;
  picked_up_at: string | null; delivered_at: string | null; payment_url?: string | null;
}

const STEPS: { key: Status; label: string; Icon: typeof Check }[] = [
  { key: 'nuevo', label: 'Recibido', Icon: Clock },
  { key: 'aceptado', label: 'En preparación', Icon: ChefHat },
  { key: 'listo', label: 'Listo', Icon: PackageCheck },
  { key: 'en_camino', label: 'En camino', Icon: Bike },
  { key: 'entregado', label: 'Entregado', Icon: Check },
];
const POLL_MS = 15000;
const PAY_POLL_MS = 4000;

/** Seguimiento del pedido de NeuronPOS Delivery (/delivery/pedido/:token). */
export default function TrackPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const back = params.get('pago');
  const [o, setO] = useState<Tracked | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ order: Tracked }>(`/marketplace/orders/${token}`, { noRedirect: true })
      .then((r) => { setO(r.order); setError(''); })
      .catch((e) => setError(errorMessage(e)));
  }, [token]);
  useEffect(() => {
    resetBranding();
    document.title = 'Tu pedido · NeuronPOS Delivery';
    load();
  }, [load]);
  // Esperando el pago: se consulta mas seguido (el servidor concilia con Clip).
  const paying = o?.status === 'pago_pendiente';
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, paying ? PAY_POLL_MS : POLL_MS);
    return () => clearInterval(t);
  }, [load, paying]);

  const failed = o && (o.status === 'rechazado' || o.status === 'cancelado');
  const at = o ? STEPS.findIndex((s) => s.key === o.status) : -1;
  return (
    <div className="min-h-screen bg-gray-950">
      <div className="mx-auto max-w-lg px-4 py-6">
        <Link to="/delivery" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> NeuronPOS Delivery</Link>
        {!o ? (error ? <Alert>{error}</Alert> : <Spinner />) : (
          <div className="space-y-4">
            <section className="card p-5">
              <div className="flex items-center gap-3">
                {o.restaurant.logo_url ? <img src={o.restaurant.logo_url} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <Store className="h-10 w-10 text-gray-500" />}
                <div>
                  <h1 className="text-lg font-semibold text-white">{o.restaurant.name}</h1>
                  <p className="text-sm text-gray-400">Pedido #{o.folio} · {formatTime(o.created_at)}</p>
                </div>
              </div>
              <p className={`mt-4 text-xl font-semibold ${failed ? 'text-red-300' : 'text-white'}`}>{o.status_label}</p>
              {failed && o.cancel_reason && <p className="mt-1 flex items-center gap-2 text-sm text-red-200"><XCircle className="h-4 w-4" /> {o.cancel_reason}</p>}
              {paying && (
                <div className="mt-3 space-y-2 text-sm">
                  <p className="text-gray-300">
                    {back === 'ok' ? 'Estamos confirmando tu pago con Clip…'
                      : back === 'error' || back === 'cancelado' ? 'El pago no se completó. Puedes intentarlo otra vez.'
                        : 'Tu pedido se envía al restaurante en cuanto se confirma el pago.'}
                  </p>
                  {o.payment_url && back !== 'ok' && (
                    <a href={o.payment_url} className="btn-brand inline-flex items-center gap-2"><CreditCard className="h-4 w-4" /> Pagar con tarjeta</a>
                  )}
                </div>
              )}
              {o.status === 'aceptado' && o.estimated_ready_at && <p className="mt-1 text-sm text-gray-400">Estará listo cerca de las {formatTime(o.estimated_ready_at)}</p>}
              {!failed && !paying && (
                <ol className="mt-5 grid grid-cols-5 gap-1">
                  {STEPS.map((s, i) => (
                    <li key={s.key} className="flex flex-col items-center gap-1 text-center">
                      <span className={`rounded-full p-2 ${i <= at ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-500'}`}><s.Icon className="h-4 w-4" /></span>
                      <span className={`text-[11px] ${i <= at ? 'text-white' : 'text-gray-500'}`}>{s.label}</span>
                    </li>
                  ))}
                </ol>
              )}
              {o.restaurant.phone && (
                <a href={`tel:${o.restaurant.phone.replace(/[^\d+]/g, '')}`} className="mt-4 inline-flex items-center gap-2 text-sm text-sky-300"><Phone className="h-4 w-4" /> Llamar al restaurante</a>
              )}
            </section>
            <section className="card p-5 text-sm">
              <h2 className="mb-2 font-semibold text-white">Tu pedido</h2>
              <ul className="space-y-1">
                {o.items.map((i, k) => (
                  <li key={k} className="flex justify-between gap-2 text-gray-300">
                    <span>{i.quantity} × {i.name}{i.modifiers.length > 0 && <span className="text-gray-500"> ({i.modifiers.join(', ')})</span>}</span>
                    <span>{formatMXN(i.line_total)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 space-y-1 border-t border-gray-800 pt-2">
                <div className="flex justify-between text-gray-300"><span>Envío</span><span>{formatMXN(o.delivery_fee)}</span></div>
                <div className="flex justify-between font-semibold text-white"><span>{o.payment_method === 'tarjeta' ? 'Total con tarjeta' : 'Total en efectivo'}</span><span>{formatMXN(o.total)}</span></div>
                {o.pay_with && <div className="text-xs text-gray-500">Pagas con {formatMXN(o.pay_with)}</div>}
              </div>
              <p className="mt-3 text-gray-400">Entregar en: {o.address}{o.reference && ` (${o.reference})`}</p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
