import { Bell, Check, ChefHat, MapPin, PackageCheck, Phone, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ChatButton } from './OrderChat';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';

interface DeliveryOrder {
  id: string; branch_name: string; folio: number; status: 'nuevo' | 'aceptado' | 'listo' | 'en_camino' | 'entregado' | 'rechazado' | 'cancelado';
  customer_name: string; customer_phone: string; address: string; reference: string | null; distance_km: string;
  food_total: string; delivery_fee: string; total: string; pay_with: string | null; cancel_reason: string | null; notes: string | null;
  estimated_ready_at: string | null; created_at: string; payment_method: 'efectivo' | 'tarjeta'; driver_assigned: boolean; messages: number;
  items: { name: string; quantity: number; notes: string | null; modifiers: string[] }[];
}

const LABEL: Record<DeliveryOrder['status'], string> = {
  nuevo: 'Nuevo', aceptado: 'En preparación', listo: 'Listo para el repartidor', en_camino: 'En camino',
  entregado: 'Entregado', rechazado: 'Rechazado', cancelado: 'Cancelado',
};
const POLL_MS = 15000;

/**
 * Pedidos que llegan por NeuronPOS Delivery: aceptar (entra a cocina) o
 * rechazar con motivo, y marcar listo para que el repartidor lo recoja.
 * El repartidor paga la comida al recogerla.
 */
export default function DeliveryOrders() {
  const [orders, setOrders] = useState<DeliveryOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    api<{ orders: DeliveryOrder[] }>('/marketplace/orders').then((r) => { setOrders(r.orders); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const act = async (o: DeliveryOrder, action: 'accept' | 'reject' | 'ready') => {
    let body: Record<string, unknown> | undefined;
    if (action === 'reject') {
      const reason = window.prompt(`¿Por qué no puedes aceptar el pedido #${o.folio}? (lo ve el cliente)`);
      if (!reason) return;
      body = { reason };
    }
    setBusy(`${o.id}:${action}`);
    try {
      await api(`/marketplace/orders/${o.id}/${action}`, { method: 'POST', body });
      load();
    } catch (e) { setError(errorMessage(e)); }
    setBusy('');
  };

  const active = (orders || []).filter((o) => ['nuevo', 'aceptado', 'listo', 'en_camino'].includes(o.status));
  const done = (orders || []).filter((o) => !active.includes(o));
  const fresh = active.filter((o) => o.status === 'nuevo').length;
  return (
    <section className="card mb-6 p-5">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-white">
        <Bell className={`h-5 w-5 ${fresh ? 'text-amber-300' : 'text-brand'}`} /> Pedidos de Delivery
        {fresh > 0 && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-gray-950">{fresh} nuevo{fresh > 1 ? 's' : ''}</span>}
      </h2>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {orders && active.length === 0 && <p className="py-3 text-sm text-gray-500">Sin pedidos en curso. Esta pantalla se actualiza sola.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {active.map((o) => (
          <article key={o.id} className={`rounded-xl border p-4 ${o.status === 'nuevo' ? 'border-amber-600/70 bg-amber-950/20' : 'border-gray-800 bg-gray-950/40'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-white">#{o.folio} · {o.customer_name}</span>
              <span className="text-xs text-gray-400">{formatTime(o.created_at)} · {LABEL[o.status]}</span>
            </div>
            <ul className="mt-2 space-y-0.5 text-sm text-gray-200">
              {o.items.map((i, k) => (
                <li key={k}>{i.quantity} × {i.name}{i.modifiers.length > 0 && <span className="text-gray-400"> ({i.modifiers.join(', ')})</span>}{i.notes && <span className="text-amber-200"> · {i.notes}</span>}</li>
              ))}
            </ul>
            {o.notes && <p className="mt-1 text-sm text-amber-200">Nota: {o.notes}</p>}
            <p className="mt-2 text-sm text-gray-300">Comida <b>{formatMXN(o.food_total)}</b> <span className="text-gray-500">· el repartidor te la paga al recoger</span>
              {o.payment_method === 'tarjeta' && <span className="ml-2 rounded-full bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300">Cliente pagó con tarjeta</span>}</p>
            {['aceptado', 'listo'].includes(o.status) && (
              <p className="mt-1 text-xs text-gray-400">{o.driver_assigned ? 'Un repartidor ya va por el pedido.' : 'Buscando repartidor en la zona…'}</p>
            )}
            <p className="mt-1 flex items-center gap-1 text-xs text-gray-400"><MapPin className="h-3.5 w-3.5" /> {o.address} · {Number(o.distance_km).toFixed(1)} km</p>
            <a href={`tel:${o.customer_phone.replace(/[^\d+]/g, '')}`} className="mt-1 inline-flex items-center gap-1 text-xs text-sky-300"><Phone className="h-3.5 w-3.5" /> {o.customer_phone}</a>
            {o.status === 'aceptado' && o.estimated_ready_at && <p className="mt-1 text-xs text-gray-400">Listo a las {formatTime(o.estimated_ready_at)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <ChatButton chatKey={`r:${o.id}`} count={o.messages} title={`Chat del pedido #${o.folio}`} me="restaurante"
                path={`/marketplace/orders/${o.id}/messages`} call={api} />
              {o.status === 'nuevo' && (
                <>
                  <Button className="flex-1" loading={busy === `${o.id}:accept`} onClick={() => void act(o, 'accept')}><Check className="h-4 w-4" /> Aceptar</Button>
                  <Button variant="ghost" disabled={busy !== ''} onClick={() => void act(o, 'reject')}><X className="h-4 w-4" /> Rechazar</Button>
                </>
              )}
              {o.status === 'aceptado' && (
                <Button className="flex-1" loading={busy === `${o.id}:ready`} onClick={() => void act(o, 'ready')}><PackageCheck className="h-4 w-4" /> Marcar listo</Button>
              )}
              {o.status === 'listo' && <span className="flex items-center gap-1 text-sm text-emerald-300"><ChefHat className="h-4 w-4" /> Esperando al repartidor</span>}
            </div>
          </article>
        ))}
      </div>
      {done.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-gray-400">Terminados hoy ({done.length})</summary>
          <ul className="mt-2 divide-y divide-gray-800">
            {done.map((o) => (
              <li key={o.id} className="flex justify-between py-2 text-gray-300">
                <span>#{o.folio} · {o.customer_name}</span>
                <span className="text-gray-500">{LABEL[o.status]}{o.cancel_reason && `: ${o.cancel_reason}`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
