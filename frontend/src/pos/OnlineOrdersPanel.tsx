import { Bike, Check, ChefHat, Clock, CreditCard, Globe, MapPin, Phone, RefreshCw, Store, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { ORDER_STATUS_LABEL, ORDER_STATUS_STYLE, formatTime, minutesSince, num, posCan } from './lib';
import type { Order } from './types';
import type { Role } from '../lib/types';

const POLL_MS = 10000;

/**
 * Pedidos en linea de la sucursal dentro de la pantalla de venta: los
 * pendientes se aceptan (van a cocina) o se rechazan con motivo (el cliente
 * lo ve en su seguimiento). Los aceptados se abren para cobrarlos con el
 * flujo normal de caja; los de domicilio se marcan "salió a reparto".
 */
export default function OnlineOrdersPanel({ branchId, role, onOpen, onChanged }: {
  branchId: string; role: Role; onOpen: (id: string) => void; onChanged: (pending: number) => void;
}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const canAct = posCan.cashier(role);

  const load = useCallback(() => {
    api<{ orders: Order[]; pending_count: number }>(`/pos/online-orders?branch_id=${branchId}&status=activas`)
      .then((r) => { setOrders(r.orders); onChanged(r.pending_count); setError(''); setNow(Date.now()); })
      .catch((e) => setError(errorMessage(e)));
  }, [branchId, onChanged]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function act(o: Order, action: 'accept' | 'reject' | 'dispatch') {
    let body: Record<string, unknown> | undefined;
    if (action === 'reject') {
      const reason = window.prompt('Motivo del rechazo (el cliente lo verá):');
      if (!reason?.trim()) return;
      body = { reason: reason.trim() };
    }
    setBusy(o.id);
    setError('');
    try {
      await api(`/pos/online-orders/${o.id}/${action}`, { method: 'POST', body });
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!orders) return error ? <Alert>{error}</Alert> : <Spinner />;
  const pending = orders.filter((o) => o.online_status === 'pendiente');
  const active = orders.filter((o) => o.online_status !== 'pendiente');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-400">Pedidos hechos desde el portal de clientes. Se actualiza cada 10 segundos.</p>
        <Button variant="ghost" onClick={load}><RefreshCw className="h-4 w-4" /> Actualizar</Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {orders.length === 0 && <p className="py-10 text-center text-sm text-gray-500">No hay pedidos en línea activos.</p>}

      {pending.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-amber-300">
            <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" /></span>
            Por aceptar ({pending.length})
          </h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((o) => (
              <OnlineCard key={o.id} order={o} now={now}>
                {canAct ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" onClick={() => act(o, 'reject')} disabled={busy === o.id}><X className="h-4 w-4" /> Rechazar</Button>
                    <Button onClick={() => act(o, 'accept')} loading={busy === o.id}><Check className="h-4 w-4" /> Aceptar</Button>
                  </div>
                ) : <p className="text-xs text-gray-500">Un cajero o gerente debe aceptarlo.</p>}
              </OnlineCard>
            ))}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500">En curso ({active.length})</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {active.map((o) => (
              <OnlineCard key={o.id} order={o} now={now}>
                <div className="flex flex-wrap gap-2">
                  {canAct && o.order_type === 'domicilio' && !o.dispatched_at && (
                    <Button variant="secondary" onClick={() => act(o, 'dispatch')} loading={busy === o.id}><Bike className="h-4 w-4" /> Salió a reparto</Button>
                  )}
                  <Button className="flex-1" onClick={() => onOpen(o.id)}>
                    <CreditCard className="h-4 w-4" /> {canAct ? `Abrir y cobrar ${formatMXN(num(o.total) - num(o.paid_amount))}` : 'Abrir'}
                  </Button>
                </div>
              </OnlineCard>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function OnlineCard({ order: o, now, children }: { order: Order; now: number; children: ReactNode }) {
  const delivery = o.order_type === 'domicilio';
  return (
    <article className={`card flex flex-col gap-3 p-4 ${o.online_status === 'pendiente' ? 'border-amber-500/60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 font-semibold text-white">
            <Globe className="h-4 w-4 text-brand" /> Folio {o.folio}
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-300">
              {delivery ? <><Bike className="h-3 w-3" /> Domicilio</> : <><Store className="h-3 w-3" /> Recoger</>}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
            <Clock className="h-3 w-3" /> {formatTime(o.created_at)} · hace {minutesSince(o.created_at, now)} min
            {o.estimated_ready_at && ` · listo ~${formatTime(o.estimated_ready_at)}`}
          </p>
        </div>
        {o.online_status === 'pendiente'
          ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/30">Nuevo</span>
          : <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${ORDER_STATUS_STYLE[o.status]}`}>
            {o.dispatched_at && o.status !== 'pagada' ? 'En camino' : ORDER_STATUS_LABEL[o.status]}
          </span>}
      </div>
      <div className="text-sm text-gray-300">
        <p className="font-medium text-white">{o.customer_name}</p>
        {o.customer_phone && <p className="flex items-center gap-1.5 text-gray-400"><Phone className="h-3.5 w-3.5" /> <a href={`tel:${o.customer_phone}`}>{o.customer_phone}</a></p>}
        {delivery && o.customer_address && (
          <p className="flex gap-1.5 text-gray-400"><MapPin className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{o.customer_address}{o.delivery_reference && ` · ${o.delivery_reference}`}</p>
        )}
      </div>
      <ul className="space-y-1 rounded-xl bg-gray-950/60 p-3 text-sm">
        {(o.items || []).map((it) => (
          <li key={it.id} className="flex gap-2">
            <span className="w-6 text-right font-semibold text-gray-300">{it.quantity}</span>
            <span className="min-w-0 flex-1 text-white">
              {it.name}
              {it.modifiers.length > 0 && <span className="block text-xs text-gray-400">{it.modifiers.map((m) => m.name).join(', ')}</span>}
              {it.notes && <span className="block text-xs italic text-amber-200/80">{it.notes}</span>}
            </span>
            <span className="text-gray-400">{formatMXN(it.line_total)}</span>
          </li>
        ))}
      </ul>
      {o.notes && <p className="flex gap-1.5 text-xs text-amber-200/90"><ChefHat className="h-3.5 w-3.5 flex-shrink-0" /> {o.notes}</p>}
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-400">
          Paga al {delivery ? 'recibir' : 'recoger'}: {o.payment_preference === 'tarjeta' ? 'tarjeta' : 'efectivo'}
          {num(o.pay_with) > 0 && ` (con ${formatMXN(o.pay_with)})`}
          {num(o.delivery_fee) > 0 && ` · envío ${formatMXN(o.delivery_fee)}`}
        </span>
        <span className="text-base font-semibold text-white">{formatMXN(o.total)}</span>
      </div>
      {children}
    </article>
  );
}
