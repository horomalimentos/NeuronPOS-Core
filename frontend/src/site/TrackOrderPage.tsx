import { Bike, Check, ChefHat, ClipboardCheck, CreditCard, Loader2, PackageCheck, Phone, Store, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import LiveMap from '../delivery/LiveMap';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { Notice } from './OrderPage';
import { STATUS_STYLE, formatDateTimeShort, formatTimeShort, isFinal } from './portalLib';
import type { CustomerDelivery, CustomerOrder, CustomerStatus, PaymentStart } from './types';

const POLL_MS = 8000;

/**
 * Seguimiento de un pedido (cliente con cuenta o invitado, por token). Se
 * actualiza solo cada 8 segundos hasta que el pedido termina.
 */
export default function TrackOrderPage() {
  const { token = '' } = useParams();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);
  const finished = useRef(false);

  const load = useCallback(() => {
    portalApi<{ order: CustomerOrder }>(`/portal/track/${encodeURIComponent(token)}`, { noRedirect: true })
      .then((r) => { setOrder(r.order); setError(''); finished.current = isFinal(r.order.status); })
      .catch((e) => setError(errorMessage(e)));
  }, [token]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && !finished.current) load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function cancel() {
    if (!window.confirm('¿Cancelar tu pedido?')) return;
    setCancelling(true);
    try {
      setOrder((await portalApi<{ order: CustomerOrder }>(`/portal/track/${encodeURIComponent(token)}/cancel`, { method: 'POST', noRedirect: true })).order);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCancelling(false);
    }
  }

  // Pedido con pago en linea pendiente: abre (o crea) la liga de Clip.
  async function payNow() {
    setPaying(true);
    try {
      const r = await portalApi<{ payment: PaymentStart }>(`/portal/track/${encodeURIComponent(token)}/pay`, { method: 'POST', noRedirect: true });
      if (r.payment.action === 'redirect' && r.payment.url) {
        window.location.assign(r.payment.url);
        return;
      }
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
    setPaying(false);
  }

  if (!order) {
    return error ? <p className="px-6 py-24 text-center text-gray-500">{error}</p>
      : <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const done = isFinal(order.status);
  const delivery = order.order_type === 'domicilio';
  const steps: { key: CustomerStatus; label: string; icon: typeof Check }[] = [
    { key: 'recibido', label: 'Recibido', icon: ClipboardCheck },
    { key: 'preparando', label: 'En preparación', icon: ChefHat },
    delivery ? { key: 'en_camino', label: 'En camino', icon: Bike } : { key: 'listo', label: 'Listo para recoger', icon: Store },
    { key: 'entregado', label: 'Entregado', icon: PackageCheck },
  ];
  const order_ = ['recibido', 'preparando', 'listo', 'en_camino', 'entregado'];
  const rank = (s: CustomerStatus) => order_.indexOf(s);
  const failed = order.status === 'rechazado' || order.status === 'cancelado';
  const awaitingPayment = order.status === 'esperando_pago';
  const paidOnline = order.online_payment_status === 'pagado';
  const paymentLabel = paidOnline ? (order.payment_provider === 'monedero' ? 'Pagado con tu monedero' : 'Pagado en línea con Clip')
    : order.online_payment_status ? 'Pago en línea con Clip pendiente'
      : order.paid ? 'Pagado'
        : `Pago al ${delivery ? 'recibir' : 'recoger'}: ${order.payment_preference === 'tarjeta' ? 'tarjeta' : 'efectivo'}`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="card-light p-6 text-center">
        <p className="text-sm text-gray-500">Pedido #{order.folio} · {formatDateTimeShort(order.created_at)}</p>
        <h1 className="mt-2 text-2xl font-bold">{order.status_label}</h1>
        <span className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLE[order.status]}`}>
          {delivery ? 'A domicilio' : 'Para recoger'}
        </span>
        {order.estimated_ready_at && !done && !failed && (
          <p className="mt-3 text-sm text-gray-600">Hora estimada: <b>{formatTimeShort(order.estimated_ready_at)}</b>{delivery && ' (más el envío)'}</p>
        )}

        {awaitingPayment ? (
          <div className="mx-auto mt-5 max-w-md rounded-2xl bg-violet-50 p-4 text-left text-sm text-violet-900">
            <p className="flex items-center gap-2 font-semibold"><CreditCard className="h-5 w-5" /> Falta pagar tu pedido</p>
            <p className="mt-1">El restaurante lo empezará a preparar en cuanto se confirme tu pago con Clip.</p>
            {order.payment_due_at && <p className="mt-1">Si no se paga antes de las <b>{formatTimeShort(order.payment_due_at)}</b>, el pedido se cancela solo.</p>}
            <button className="btn-brand mt-3 w-full" onClick={payNow} disabled={paying}>
              {paying && <Loader2 className="h-4 w-4 animate-spin" />} Pagar ahora con Clip
            </button>
          </div>
        ) : failed ? (
          <div className="mx-auto mt-5 max-w-md rounded-2xl bg-red-50 p-4 text-left text-sm text-red-800">
            <p className="flex items-center gap-2 font-semibold"><XCircle className="h-5 w-5" /> {order.status === 'rechazado' ? 'El restaurante no pudo aceptar tu pedido' : 'Pedido cancelado'}</p>
            {order.cancel_reason && <p className="mt-1">Motivo: {order.cancel_reason}</p>}
          </div>
        ) : (
          <ol className="mt-6 grid grid-cols-4 gap-1">
            {steps.map((s) => {
              const reached = rank(order.status) >= rank(s.key) || (s.key === 'en_camino' && order.status === 'entregado');
              const current = order.status === s.key || (s.key === 'en_camino' && order.status === 'listo');
              const Icon = s.icon;
              return (
                <li key={s.key} className="flex flex-col items-center gap-1.5 text-center">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-full
                    ${reached ? 'bg-brand text-brand-contrast' : 'bg-gray-100 text-gray-400'} ${current && !done ? 'ring-4 ring-brand/20' : ''}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className={`text-xs ${reached ? 'font-semibold text-gray-900' : 'text-gray-400'}`}>{s.label}</span>
                </li>
              );
            })}
          </ol>
        )}
        {!done && <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-gray-400"><Loader2 className="h-3 w-3 animate-spin" /> Se actualiza automáticamente</p>}
      </div>

      {error && <div className="mt-4"><Notice kind="error">{error}</Notice></div>}

      {order.delivery && !failed && <DeliveryCard d={order.delivery} />}

      <div className="card-light mt-4 p-5">
        <h2 className="font-bold">{order.branch.name || 'Sucursal'}</h2>
        {order.branch.address && <p className="text-sm text-gray-500">{order.branch.address}</p>}
        {order.branch.phone && (
          <a href={`tel:${order.branch.phone.replace(/[^+\d]/g, '')}`} className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-brand">
            <Phone className="h-4 w-4" /> {order.branch.phone}
          </a>
        )}
        {delivery && order.customer_address && (
          <p className="mt-3 text-sm text-gray-700"><b>Entregar en:</b> {order.customer_address}{order.delivery_reference && ` (${order.delivery_reference})`}</p>
        )}
        <ul className="mt-4 divide-y divide-gray-100 text-sm">
          {order.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-3 py-2">
              <span>
                {it.quantity} × {it.name}
                {it.modifiers.length > 0 && <span className="block text-xs text-gray-500">{it.modifiers.map((m) => m.name).join(', ')}</span>}
                {it.notes && <span className="block text-xs italic text-gray-500">“{it.notes}”</span>}
              </span>
              <span className="whitespace-nowrap">{formatMXN(it.line_total)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 space-y-1 border-t border-gray-100 pt-3 text-sm">
          <div className="flex justify-between text-gray-600"><span>Subtotal</span><span>{formatMXN(order.subtotal)}</span></div>
          {Number(order.discount_amount) > 0 && <div className="flex justify-between text-gray-600"><span>Descuento</span><span>-{formatMXN(order.discount_amount)}</span></div>}
          {Number(order.delivery_fee) > 0 && <div className="flex justify-between text-gray-600"><span>Envío</span><span>{formatMXN(order.delivery_fee)}</span></div>}
          <div className="flex justify-between text-base font-bold"><span>Total</span><span>{formatMXN(order.total)}</span></div>
          <p className="text-xs text-gray-500">
            {paymentLabel}
            {!order.paid && !order.online_payment_status && order.pay_with && ` · pagas con ${formatMXN(order.pay_with)}`}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap justify-center gap-3">
        {(order.status === 'recibido' || awaitingPayment) && !paidOnline && (
          <button className="btn-outline" onClick={cancel} disabled={cancelling}>{cancelling && <Loader2 className="h-4 w-4 animate-spin" />} Cancelar pedido</button>
        )}
        <Link to="/pedir" className="btn-brand">Hacer otro pedido</Link>
      </div>
    </div>
  );
}

/** Estado del repartidor y, mientras va en camino, su ubicacion aproximada. */
function DeliveryCard({ d }: { d: CustomerDelivery }) {
  const tone = d.status === 'fallido' ? 'bg-red-50 text-red-800' : d.status === 'entregado' ? 'bg-emerald-50 text-emerald-800' : 'bg-orange-50 text-orange-900';
  const text = d.status === 'solicitado' ? 'Buscando un repartidor para tu pedido.'
    : d.status === 'asignado' ? `${d.driver_name || 'Tu repartidor'} va por tu pedido al restaurante.`
      : d.status === 'recogido' ? `${d.driver_name || 'Tu repartidor'} ya recogió tu pedido.`
        : d.status === 'en_camino' ? `${d.driver_name || 'Tu repartidor'} va en camino${d.on_way_at ? ` desde las ${formatTimeShort(d.on_way_at)}` : ''}.`
          : d.status === 'entregado' ? `Entregado${d.delivered_at ? ` a las ${formatTimeShort(d.delivered_at)}` : ''}.`
            : `No se pudo entregar${d.fail_reason ? `: ${d.fail_reason}` : ''}. El restaurante se comunicará contigo.`;
  return (
    <div className="card-light mt-4 p-5">
      <p className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium ${tone}`}>
        <Bike className="h-5 w-5 shrink-0" /> {text.replace(/\.\.$/, '.')}
      </p>
      {d.status === 'en_camino' && d.location && (
        <div className="mt-4">
          <LiveMap className="h-64" points={[{ id: 'driver', latitude: d.location.latitude, longitude: d.location.longitude, label: d.driver_name || 'Repartidor' }]} />
          <p className="mt-2 text-xs text-gray-500">Ubicación aproximada, actualizada a las {formatTimeShort(d.location.updated_at)}.</p>
        </div>
      )}
    </div>
  );
}
