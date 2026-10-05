import {
  Bike, Check, CircleSlash, MapPin, Navigation, Phone, RefreshCw, Send, UserRound, Wallet, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import BranchSelect from '../pos/BranchSelect';
import { formatTime } from '../pos/lib';
import { usePosBranch } from '../pos/usePosBranch';
import LiveMap, { type MapPoint } from './LiveMap';
import { DELIVERY_STATUS_STYLE, ago, mapsHref, telHref } from './lib';
import type { BranchDriver, Delivery, DispatchBoard, DispatchOrder, MapDriver } from './types';

const POLL_MS = 10000;

/**
 * Reparto (caja): pedidos a domicilio de la sucursal listos para salir. Con
 * repartidores propios la caja elige quien se lleva cada pedido y sigue sus
 * estados; con la flota de NeuronPOS pide un repartidor y ve su avance.
 */
export default function DispatchPage() {
  const { branchId, setBranchId, branches } = usePosBranch();
  const [board, setBoard] = useState<DispatchBoard | null>(null);
  const [mapDrivers, setMapDrivers] = useState<MapDriver[]>([]);
  const [error, setError] = useState('');
  const [assigning, setAssigning] = useState<DispatchOrder | null>(null);
  const [delivering, setDelivering] = useState<{ order: DispatchOrder; mode: 'entregado' | 'fallido' } | null>(null);
  const [requesting, setRequesting] = useState<DispatchOrder | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    if (!branchId) return;
    api<DispatchBoard>(`/delivery/board?branch_id=${branchId}`)
      .then((b) => { setBoard(b); setError(''); }).catch((e) => setError(errorMessage(e)));
    api<{ drivers: MapDriver[] }>(`/delivery/map?branch_id=${branchId}`)
      .then((r) => setMapDrivers(r.drivers)).catch(() => {});
  }, [branchId]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    try {
      await fn();
      load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy('');
    }
  }

  const setStatus = (d: Delivery, status: string, extra: Record<string, unknown> = {}) =>
    run(`${d.id}:${status}`, () => api(`/delivery/deliveries/${d.id}/status`, { method: 'POST', body: { status, ...extra } }));

  const points: MapPoint[] = useMemo(() => mapDrivers.map((d) => ({
    id: `${d.kind}:${d.id}`,
    latitude: Number(d.latitude),
    longitude: Number(d.longitude),
    label: `${d.name}${d.folio ? ` · #${d.folio}` : ''}`,
    color: d.kind === 'horom' ? '#7c3aed' : '#ea580c',
  })), [mapDrivers]);

  if (!board) return error ? <Alert>{error}</Alert> : <Spinner />;
  const horom = board.settings.mode === 'horom';
  const cols: { key: DispatchOrder['stage']; title: string }[] = [
    { key: 'por_asignar', title: horom ? 'Por pedir repartidor' : 'Por asignar' },
    { key: 'en_reparto', title: 'En reparto' },
    { key: 'entregado', title: 'Entregados (24 h)' },
  ];

  return (
    <>
      <PageHeader
        title="Reparto"
        subtitle={horom
          ? 'Tus pedidos a domicilio los entrega la flota de repartidores de NeuronPOS.'
          : 'La caja elige qué repartidor se lleva cada pedido a domicilio.'}
        actions={(
          <>
            <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
            {!horom && <Link to="/admin/reparto/cortes" className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-100 hover:bg-gray-700"><Wallet className="h-4 w-4" /> Cortes de repartidores</Link>}
            <Button variant="ghost" onClick={load} aria-label="Actualizar"><RefreshCw className="h-4 w-4" /></Button>
          </>
        )}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="grid gap-4 lg:grid-cols-3">
          {cols.map((c) => {
            const list = board.orders.filter((o) => o.stage === c.key);
            return (
              <section key={c.key}>
                <h2 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">{c.title} <span className="text-gray-600">({list.length})</span></h2>
                <div className="space-y-3">
                  {list.length === 0 && <p className="card p-4 text-sm text-gray-500">Nada por aquí.</p>}
                  {list.map((o) => (
                    <OrderCard key={o.id} order={o} horom={horom} busy={busy}
                      onAssign={() => setAssigning(o)}
                      onRequest={() => setRequesting(o)}
                      onStatus={(status) => (status === 'entregado' || status === 'fallido'
                        ? setDelivering({ order: o, mode: status })
                        : setStatus(o.delivery!, status, status === 'cancelado' ? { reason: 'Se quitó el pedido al repartidor' } : {}))}
                      onCancelRequest={() => run(`${o.id}:cancel`, () => api(`/delivery/requests/${o.delivery!.id}/cancel`, { method: 'POST', body: {} }))}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="space-y-4">
          <LiveMap points={points} className="h-72" emptyLabel="Ningún repartidor compartiendo ubicación" />
          {!horom && <DriversList drivers={board.drivers} />}
        </aside>
      </div>

      {assigning && (
        <AssignModal order={assigning} drivers={board.drivers} onClose={() => setAssigning(null)}
          onAssign={async (driverId) => {
            const ok = await run('assign', () => api(`/delivery/orders/${assigning.id}/assign`, { method: 'POST', body: { driver_user_id: driverId } }));
            if (ok) setAssigning(null);
          }} />
      )}
      {requesting && (
        <RequestModal order={requesting} onClose={() => setRequesting(null)}
          onRequest={async (notes) => {
            const ok = await run('request', () => api(`/delivery/orders/${requesting.id}/request`, { method: 'POST', body: { notes } }));
            if (ok) setRequesting(null);
          }} />
      )}
      {delivering && delivering.order.delivery && (
        <FinishModal order={delivering.order} mode={delivering.mode} onClose={() => setDelivering(null)}
          onConfirm={async (body) => {
            const ok = await setStatus(delivering.order.delivery!, delivering.mode, body);
            if (ok) setDelivering(null);
          }} />
      )}
    </>
  );
}

function OrderCard({ order: o, horom, busy, onAssign, onRequest, onStatus, onCancelRequest }: {
  order: DispatchOrder; horom: boolean; busy: string;
  onAssign: () => void; onRequest: () => void; onStatus: (s: string) => void; onCancelRequest: () => void;
}) {
  const d = o.delivery;
  const last = !d && o.history[0];
  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-white">#{o.folio} · {o.customer_name || 'Cliente'}</div>
          <div className="text-xs text-gray-500">{o.source === 'web' ? 'En línea' : 'POS'} · {formatTime(o.created_at)}{o.ready_at && ` · lista ${formatTime(o.ready_at)}`}</div>
        </div>
        {d && <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${DELIVERY_STATUS_STYLE[d.status]}`}>{d.status_label}</span>}
      </div>
      {o.customer_address && (
        <a href={mapsHref(o.customer_address)} target="_blank" rel="noreferrer" className="mt-2 flex items-start gap-1.5 text-sm text-gray-300 hover:text-white">
          <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500" />
          <span>{o.customer_address}{o.delivery_reference && <span className="text-gray-500"> · {o.delivery_reference}</span>}</span>
        </a>
      )}
      {o.customer_phone && (
        <a href={telHref(o.customer_phone)} className="mt-1 flex items-center gap-1.5 text-sm text-gray-400 hover:text-white"><Phone className="h-4 w-4" /> {o.customer_phone}</a>
      )}
      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="text-gray-400">Total {formatMXN(o.total)}</span>
        {o.remaining > 0
          ? <span className="font-semibold text-amber-300">Cobrar {formatMXN(o.remaining)}{o.pay_with && ` · paga con ${formatMXN(o.pay_with)}`}</span>
          : <span className="text-emerald-300">Pagado</span>}
      </div>
      {last && <p className="mt-2 text-xs text-red-300">Último intento: {last.status_label}{last.fail_reason && ` — ${last.fail_reason}`}</p>}
      {d && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-gray-300">
          <UserRound className="h-4 w-4 text-gray-500" />
          {d.driver_name || (d.kind === 'horom' ? 'Buscando repartidor…' : '—')}
          {d.driver_phone && <a href={telHref(d.driver_phone)} className="text-gray-400 hover:text-white">· {d.driver_phone}</a>}
          {d.kind === 'horom' && <span className="ml-auto text-xs text-violet-300">Flota</span>}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {o.stage === 'por_asignar' && (horom
          ? <Button className="flex-1" onClick={onRequest}><Send className="h-4 w-4" /> Pedir repartidor</Button>
          : <Button className="flex-1" onClick={onAssign}><Bike className="h-4 w-4" /> Asignar repartidor</Button>)}
        {d?.kind === 'propio' && d.status === 'asignado' && (
          <>
            <Button className="flex-1" loading={busy === `${d.id}:recogido`} onClick={() => onStatus('recogido')}><Check className="h-4 w-4" /> Entregado a repartidor</Button>
            <Button variant="secondary" onClick={onAssign}>Cambiar</Button>
            <Button variant="ghost" loading={busy === `${d.id}:cancelado`} onClick={() => onStatus('cancelado')} aria-label="Quitar repartidor"><X className="h-4 w-4" /></Button>
          </>
        )}
        {d?.kind === 'propio' && d.status === 'recogido' && (
          <Button className="flex-1" loading={busy === `${d.id}:en_camino`} onClick={() => onStatus('en_camino')}><Navigation className="h-4 w-4" /> En camino</Button>
        )}
        {d?.kind === 'propio' && d.status === 'en_camino' && (
          <Button className="flex-1" onClick={() => onStatus('entregado')}><Check className="h-4 w-4" /> Entregado</Button>
        )}
        {d?.kind === 'propio' && ['recogido', 'en_camino'].includes(d.status) && (
          <Button variant="secondary" onClick={() => onStatus('fallido')}><CircleSlash className="h-4 w-4" /> No se entregó</Button>
        )}
        {d?.kind === 'horom' && ['solicitado', 'asignado'].includes(d.status) && (
          <Button variant="secondary" loading={busy === `${o.id}:cancel`} onClick={onCancelRequest}>Cancelar solicitud</Button>
        )}
        {d?.status === 'entregado' && Number(d.cash_collected) > 0 && (
          <span className="text-xs text-gray-400">Cobrado en la puerta: {formatMXN(d.cash_collected)}</span>
        )}
      </div>
    </article>
  );
}

function DriversList({ drivers }: { drivers: BranchDriver[] }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Repartidores</h2>
      {drivers.length === 0 && (
        <p className="text-sm text-gray-500">No hay repartidores en esta sucursal. Da de alta usuarios con el rol <b>Repartidor</b> en <Link to="/admin/usuarios" className="text-brand underline">Usuarios</Link>.</p>
      )}
      <ul className="space-y-2">
        {drivers.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${d.on_duty ? 'bg-emerald-400' : 'bg-gray-600'}`} />
              <span className="text-gray-200">{d.name}</span>
            </span>
            <span className="text-right text-xs text-gray-500">
              {d.active_count > 0 ? `${d.active_count} en curso` : d.on_duty ? 'Libre' : 'Fuera de turno'}
              {Number(d.cash_pending) > 0 && <span className="block text-amber-300">Trae {formatMXN(d.cash_pending)}</span>}
              {d.on_duty && d.located_at && <span className="block">Ubicación {ago(d.located_at)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssignModal({ order, drivers, onClose, onAssign }: {
  order: DispatchOrder; drivers: BranchDriver[]; onClose: () => void; onAssign: (id: string) => void;
}) {
  return (
    <Modal title={`¿Quién se lleva el pedido #${order.folio}?`} onClose={onClose}>
      {drivers.length === 0 ? <p className="text-sm text-gray-400">No hay repartidores activos en esta sucursal.</p> : (
        <div className="grid gap-2">
          {drivers.map((d) => (
            <button key={d.id} type="button" onClick={() => onAssign(d.id)}
              disabled={order.delivery?.driver_id === d.id}
              className="flex items-center justify-between rounded-xl border border-gray-700 px-4 py-3 text-left transition hover:border-brand hover:bg-brand/10 disabled:opacity-40">
              <span className="flex items-center gap-2 text-white">
                <span className={`h-2.5 w-2.5 rounded-full ${d.on_duty ? 'bg-emerald-400' : 'bg-gray-600'}`} /> {d.name}
              </span>
              <span className="text-xs text-gray-400">{d.active_count > 0 ? `${d.active_count} en curso` : d.on_duty ? 'Libre' : 'Fuera de turno'}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function RequestModal({ order, onClose, onRequest }: { order: DispatchOrder; onClose: () => void; onRequest: (notes: string) => void }) {
  const [notes, setNotes] = useState('');
  return (
    <Modal title={`Pedir repartidor · #${order.folio}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          Se enviará a la flota de NeuronPOS la dirección de entrega, el teléfono del cliente
          {order.remaining > 0 ? <> y el efectivo a cobrar (<b className="text-white">{formatMXN(order.remaining)}</b>)</> : ' (el pedido ya está pagado)'}.
        </p>
        <Field label="Indicaciones para el repartidor (opcional)">
          <input className="input" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. tocar el timbre, casa azul" />
        </Field>
        <Button className="w-full" onClick={() => onRequest(notes)}><Send className="h-4 w-4" /> Pedir repartidor</Button>
      </div>
    </Modal>
  );
}

/** Entregado (con cobro en la puerta) o no entregado (con motivo). */
export function FinishModal({ order, mode, onClose, onConfirm }: {
  order: { folio: number; remaining: number; pay_with: string | null }; mode: 'entregado' | 'fallido';
  onClose: () => void; onConfirm: (body: Record<string, unknown>) => void;
}) {
  const [received, setReceived] = useState(order.pay_with ? String(Number(order.pay_with)) : '');
  const [tip, setTip] = useState('');
  const [reason, setReason] = useState('');
  const due = order.remaining;
  const change = Math.max(0, Math.round((Number(received || 0) - due - Number(tip || 0)) * 100) / 100);
  return (
    <Modal title={mode === 'entregado' ? `Entregar pedido #${order.folio}` : `No se entregó #${order.folio}`} onClose={onClose}>
      {mode === 'fallido' ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onConfirm({ reason }); }}>
          <Field label="Motivo"><input className="input" required value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej. el cliente no contesta" /></Field>
          <Button type="submit" variant="danger" className="w-full">Marcar como no entregado</Button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onConfirm(due > 0 ? { received: received || undefined, tip: Number(tip || 0) } : {}); }}>
          {due > 0 ? (
            <>
              <p className="text-sm text-gray-300">Cobrar en efectivo: <b className="text-xl text-white">{formatMXN(due)}</b></p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Recibido"><input className="input" type="number" min="0" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={String(due)} /></Field>
                <Field label="Propina"><input className="input" type="number" min="0" step="0.01" value={tip} onChange={(e) => setTip(e.target.value)} placeholder="0" /></Field>
              </div>
              {received && <p className="text-sm text-gray-400">Cambio: <b className="text-white">{formatMXN(change)}</b></p>}
            </>
          ) : <p className="text-sm text-emerald-300">El pedido ya está pagado: no hay que cobrar.</p>}
          <Button type="submit" className="w-full"><Check className="h-4 w-4" /> Confirmar entrega</Button>
        </form>
      )}
    </Modal>
  );
}
