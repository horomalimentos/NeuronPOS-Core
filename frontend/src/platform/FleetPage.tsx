import { Megaphone, MapPin, Phone, RefreshCw, UserMinus, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';
import LiveMap, { type MapPoint } from '../delivery/LiveMap';
import { ACTIVE, DELIVERY_STATUS_STYLE, NEXT_DRIVER_STEP, ago, telHref } from '../delivery/lib';
import type { DeliveryStatus, FleetDriver, FleetRequest } from '../delivery/types';
import { FleetDriversTab, FleetLedgerTab, FleetReportTab, FleetSettingsTab } from './FleetAdmin';

type Tab = 'tablero' | 'repartidores' | 'liquidaciones' | 'reporte' | 'ajustes';
const TABS: { value: Tab; label: string }[] = [
  { value: 'tablero', label: 'Tablero' },
  { value: 'repartidores', label: 'Repartidores' },
  { value: 'liquidaciones', label: 'Liquidaciones' },
  { value: 'reporte', label: 'Pagos a repartidores' },
  { value: 'ajustes', label: 'Ajustes' },
];

/** Flota de repartidores de NeuronPOS (domicilios en modo horom). */
export default function FleetPage() {
  const [tab, setTab] = useState<Tab>('tablero');
  return (
    <>
      <PageHeader title="Flota" subtitle="Repartidores de NeuronPOS para los restaurantes que usan la flota." />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-gray-800">
        {TABS.map((t) => (
          <button key={t.value} onClick={() => setTab(t.value)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${tab === t.value ? 'border-brand text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'tablero' && <BoardTab />}
      {tab === 'repartidores' && <FleetDriversTab />}
      {tab === 'liquidaciones' && <FleetLedgerTab />}
      {tab === 'reporte' && <FleetReportTab />}
      {tab === 'ajustes' && <FleetSettingsTab />}
    </>
  );
}

interface MapRow {
  id: string; name: string; latitude: string; longitude: string; located_at: string; on_duty: boolean;
  request: { id: string; status: DeliveryStatus; restaurant_name: string; folio: number } | null;
}

function BoardTab() {
  const [data, setData] = useState<{ requests: FleetRequest[]; drivers: FleetDriver[] } | null>(null);
  const [map, setMap] = useState<MapRow[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [failing, setFailing] = useState<{ request: FleetRequest; status: 'fallido' | 'cancelado' } | null>(null);

  const load = useCallback(() => {
    platformApi<{ requests: FleetRequest[]; drivers: FleetDriver[] }>('/platform/fleet/requests?status=activas')
      .then((d) => { setData(d); setError(''); }).catch((e) => setError(errorMessage(e)));
    platformApi<{ drivers: MapRow[] }>('/platform/fleet/map').then((d) => setMap(d.drivers)).catch(() => setMap([]));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 10000);
    return () => window.clearInterval(t);
  }, [load]);

  const points: MapPoint[] = useMemo(() => map.map((d) => ({
    id: d.id,
    latitude: Number(d.latitude),
    longitude: Number(d.longitude),
    label: d.request ? `${d.name} · ${d.request.restaurant_name} #${d.request.folio}` : d.name,
    color: d.request ? '#f97316' : '#22c55e',
  })), [map]);

  async function act(id: string, path: string, body?: object, msg?: string) {
    setBusy(id + path);
    setError('');
    try {
      await platformApi(`/platform/fleet/requests/${id}/${path}`, { method: 'POST', body: body || {} });
      if (msg) setNotice(msg);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const available = data.drivers.filter((d) => d.active);
  const open = data.requests.filter((r) => ACTIVE.includes(r.status));
  const closed = data.requests.filter((r) => !ACTIVE.includes(r.status));

  return (
    <>
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
      </div>
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><LiveMap points={points} className="h-80" emptyLabel="Ningún repartidor compartiendo ubicación" /></div>
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">Repartidores</h2>
            <button onClick={load} className="text-gray-500 hover:text-white" aria-label="Actualizar"><RefreshCw className="h-4 w-4" /></button>
          </div>
          <ul className="space-y-2 text-sm">
            {available.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${d.on_duty ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                  <span className="text-gray-200">{d.name}</span>
                </span>
                <span className="text-xs text-gray-500">
                  {d.active_requests > 0 ? `${d.active_requests} en curso` : d.on_duty ? 'Libre' : 'Fuera de turno'}
                  {d.located_at && ` · ${ago(d.located_at)}`}
                </span>
              </li>
            ))}
            {available.length === 0 && <li className="text-gray-500">Da de alta repartidores en la pestaña Repartidores.</li>}
          </ul>
        </div>
      </div>

      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Solicitudes activas ({open.length})</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {open.map((r) => (
          <RequestCard key={r.id} r={r} drivers={available} busy={busy}
            onAssign={(driverId) => act(r.id, 'assign', { driver_id: driverId }, `Solicitud #${r.order_folio} asignada.`)}
            onOffer={() => act(r.id, 'offer', {}, `Solicitud #${r.order_folio} ofrecida a los repartidores libres.`)}
            onUnassign={() => act(r.id, 'unassign', {}, `Se quitó el repartidor de #${r.order_folio}.`)}
            onStatus={(status) => act(r.id, 'status', { status })}
            onFail={(status) => setFailing({ request: r, status })} />
        ))}
        {open.length === 0 && <p className="text-sm text-gray-500">No hay solicitudes activas.</p>}
      </div>

      {closed.length > 0 && (
        <>
          <h2 className="mb-3 mt-10 text-sm font-medium uppercase tracking-wider text-gray-500">Últimas 12 horas</h2>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Pedido</th>
                  <th className="px-4 py-3 font-medium">Repartidor</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 text-right font-medium">Cobrado</th>
                  <th className="px-4 py-3 text-right font-medium">Comisión</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {closed.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 text-gray-200">{r.restaurant_name} #{r.order_folio}<span className="block text-xs text-gray-500">{r.customer_name}</span></td>
                    <td className="px-4 py-3 text-gray-400">{r.driver_name || '—'}</td>
                    <td className="px-4 py-3"><StatusPill status={r.status} label={r.status_label} />{r.fail_reason && <span className="block text-xs text-gray-500">{r.fail_reason}</span>}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMXN(r.cash_collected)}</td>
                    <td className="px-4 py-3 text-right tabular-nums"><CommissionCell r={r} onSaved={load} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {failing && (
        <ReasonModal title={failing.status === 'fallido' ? `No se entregó #${failing.request.order_folio}` : `Cancelar #${failing.request.order_folio}`}
          onClose={() => setFailing(null)}
          onSubmit={async (reason) => {
            await platformApi(`/platform/fleet/requests/${failing.request.id}/status`, { method: 'POST', body: { status: failing.status, reason } });
            setFailing(null);
            load();
          }} />
      )}
    </>
  );
}

function StatusPill({ status, label }: { status: DeliveryStatus; label: string }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${DELIVERY_STATUS_STYLE[status]}`}>{label}</span>;
}

function RequestCard({ r, drivers, busy, onAssign, onOffer, onUnassign, onStatus, onFail }: {
  r: FleetRequest; drivers: FleetDriver[]; busy: string;
  onAssign: (driverId: string) => void; onOffer: () => void; onUnassign: () => void;
  onStatus: (s: DeliveryStatus) => void; onFail: (s: 'fallido' | 'cancelado') => void;
}) {
  const [driverId, setDriverId] = useState('');
  const next = NEXT_DRIVER_STEP[r.status];
  const canFail = r.status === 'recogido' || r.status === 'en_camino';
  const canCancel = r.status === 'solicitado' || r.status === 'asignado';
  return (
    <section className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-white">{r.restaurant_name} · #{r.order_folio}</div>
          <div className="text-xs text-gray-500">Solicitado {formatTime(r.created_at)}</div>
        </div>
        <StatusPill status={r.status} label={r.status_label} />
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex gap-2 text-gray-400"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /><span><b className="text-gray-200">Recoger:</b> {r.pickup_name}{r.pickup_address && ` · ${r.pickup_address}`}</span></div>
        <div className="flex gap-2 text-gray-400"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" /><span><b className="text-gray-200">Entregar:</b> {r.dropoff_address}{r.dropoff_reference && ` (${r.dropoff_reference})`}</span></div>
        <div className="flex gap-2 text-gray-400">
          <Phone className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{r.customer_name}{r.customer_phone && <> · <a className="underline" href={telHref(r.customer_phone)}>{r.customer_phone}</a></>}</span>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-4 text-sm">
        <span className="text-gray-400">Total {formatMXN(r.order_total)}</span>
        <span className={Number(r.cash_to_collect) > 0 ? 'font-semibold text-amber-300' : 'text-emerald-300'}>
          {Number(r.cash_to_collect) > 0 ? `Cobrar ${formatMXN(r.cash_to_collect)}` : 'Ya pagado'}
        </span>
        <span className="text-gray-500">Comisión {formatMXN(r.commission_amount)}</span>
      </div>
      {r.driver_name && <p className="mt-2 text-sm text-gray-300">Repartidor: <b>{r.driver_name}</b></p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {r.status === 'solicitado' && (
          <>
            <select className="input max-w-[12rem] py-1.5 text-sm" value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label="Repartidor">
              <option value="">Elegir repartidor…</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.on_duty ? '' : ' (fuera de turno)'}</option>)}
            </select>
            <Button disabled={!driverId} loading={busy === `${r.id}assign`} onClick={() => onAssign(driverId)}>Asignar</Button>
            <Button variant="secondary" loading={busy === `${r.id}offer`} onClick={onOffer}>
              <Megaphone className="h-4 w-4" /> Ofrecer{r.open_offers > 0 && ` (${r.open_offers})`}
            </Button>
          </>
        )}
        {r.status === 'asignado' && (
          <Button variant="secondary" loading={busy === `${r.id}unassign`} onClick={onUnassign}><UserMinus className="h-4 w-4" /> Quitar</Button>
        )}
        {next && r.status !== 'solicitado' && (
          <Button variant="secondary" loading={busy === `${r.id}status`} onClick={() => onStatus(next.status)}>Marcar: {next.label}</Button>
        )}
        {canFail && <Button variant="danger" onClick={() => onFail('fallido')}>No entregado</Button>}
        {canCancel && <button onClick={() => onFail('cancelado')} className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-300"><XCircle className="h-3.5 w-3.5" /> Cancelar</button>}
      </div>
    </section>
  );
}

function CommissionCell({ r, onSaved }: { r: FleetRequest; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(r.commission_amount);
  const [error, setError] = useState('');
  const billed = Boolean(r.commission_invoice_id || r.commission_settlement_id);
  if (!editing || billed) {
    return (
      <button disabled={billed || r.status !== 'entregado'} onClick={() => setEditing(true)}
        className="tabular-nums text-gray-200 enabled:hover:underline disabled:cursor-default" title={billed ? 'Ya cobrada' : 'Corregir comisión'}>
        {formatMXN(r.commission_amount)}{billed && <span className="block text-xs text-gray-500">{r.commission_invoice_id ? 'En factura' : 'Liquidada'}</span>}
      </button>
    );
  }
  return (
    <form className="flex items-center justify-end gap-1" onSubmit={async (e) => {
      e.preventDefault();
      try {
        await platformApi(`/platform/fleet/requests/${r.id}`, { method: 'PATCH', body: { commission_amount: Number(value) } });
        setEditing(false);
        onSaved();
      } catch (err) { setError(errorMessage(err)); }
    }}>
      <input className="input w-24 py-1 text-right text-sm" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} title={error || undefined} />
      <Button type="submit" className="px-2 py-1 text-xs">OK</Button>
    </form>
  );
}

export function ReasonModal({ title, onClose, onSubmit }: { title: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Motivo"><input className="input" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        <Button type="submit" variant="danger" className="w-full" loading={saving}>Confirmar</Button>
      </form>
    </Modal>
  );
}
