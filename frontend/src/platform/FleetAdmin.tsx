import { Pencil, Plus, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner, Toggle } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { ago } from '../delivery/lib';
import type { FleetDriver, FleetSettings, LedgerRestaurant, LedgerSummary, Settlement } from '../delivery/types';

// Pestanas del Panel > Flota: repartidores, liquidaciones a restaurantes,
// reporte de pagos a repartidores y ajustes de la flota.

const SectionTitle = ({ children }: { children: string }) => (
  <h2 className="mb-3 mt-8 text-sm font-medium uppercase tracking-wider text-gray-500 first:mt-0">{children}</h2>
);

// ---------------------------------------------------------------------------
// Repartidores
// ---------------------------------------------------------------------------

export function FleetDriversTab() {
  const [drivers, setDrivers] = useState<FleetDriver[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<FleetDriver | 'new' | null>(null);
  const [cash, setCash] = useState<FleetDriver | null>(null);

  const load = useCallback(() => {
    platformApi<{ drivers: FleetDriver[] }>('/platform/fleet/drivers').then((d) => setDrivers(d.drivers)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  if (!drivers) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-gray-400">Entran en <b className="text-gray-200">/repartidor</b> (pestaña Flota) con su correo y contraseña.</p>
        <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo repartidor</Button>
      </div>
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">Repartidor</th>
              <th className="px-4 py-3 font-medium">Vehículo</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 text-right font-medium">Pago por entrega</th>
              <th className="px-4 py-3 text-right font-medium">Efectivo por entregar</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {drivers.map((d) => (
              <tr key={d.id} className={d.active ? '' : 'opacity-50'}>
                <td className="px-4 py-3 text-gray-200">{d.name}<span className="block text-xs text-gray-500">{d.email} · {d.phone}</span></td>
                <td className="px-4 py-3 text-gray-400">{[d.vehicle, d.plate].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-3 text-gray-400">
                  {!d.active ? 'Baja' : d.on_duty ? <span className="text-emerald-300">En turno</span> : 'Fuera de turno'}
                  {d.active_requests > 0 && <span className="block text-xs text-amber-300">{d.active_requests} en curso</span>}
                  {d.located_at && <span className="block text-xs text-gray-500">Ubicación {ago(d.located_at)}</span>}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{d.pay_per_delivery === null ? <span className="text-gray-500">General</span> : formatMXN(d.pay_per_delivery)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <button onClick={() => setCash(d)} className="inline-flex items-center gap-1 hover:underline">
                    {formatMXN(d.cash_pending)} <Wallet className="h-3.5 w-3.5 text-gray-500" />
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing(d)} className="text-gray-400 hover:text-white" aria-label={`Editar ${d.name}`}><Pencil className="h-4 w-4" /></button>
                </td>
              </tr>
            ))}
            {drivers.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Sin repartidores todavía.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && (
        <DriverModal driver={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); setNotice(msg); load(); }} />
      )}
      {cash && <DriverCashModal driver={cash} onClose={() => { setCash(null); load(); }} />}
    </>
  );
}

function DriverModal({ driver, onClose, onSaved }: { driver: FleetDriver | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState({
    name: driver?.name || '', phone: driver?.phone || '', email: driver?.email || '',
    vehicle: driver?.vehicle || '', plate: driver?.plate || '', notes: driver?.notes || '',
    pay_per_delivery: driver?.pay_per_delivery ?? '', password: '', active: driver?.active ?? true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body: Record<string, unknown> = {
      name: form.name, phone: form.phone, email: form.email, vehicle: form.vehicle || null, plate: form.plate || null,
      notes: form.notes || null, active: form.active,
      pay_per_delivery: form.pay_per_delivery === '' ? null : Number(form.pay_per_delivery),
    };
    if (form.password) body.password = form.password;
    try {
      if (driver) await platformApi(`/platform/fleet/drivers/${driver.id}`, { method: 'PATCH', body });
      else await platformApi('/platform/fleet/drivers', { method: 'POST', body });
      onSaved(driver ? `${form.name} actualizado.` : `${form.name} dado de alta.`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={driver ? `Editar ${driver.name}` : 'Nuevo repartidor'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required value={form.name} onChange={set('name')} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Teléfono"><input className="input" required value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Correo (para entrar)"><input className="input" type="email" required value={form.email} onChange={set('email')} /></Field>
          <Field label="Vehículo"><input className="input" value={form.vehicle} onChange={set('vehicle')} placeholder="Moto, bici…" /></Field>
          <Field label="Placas"><input className="input" value={form.plate} onChange={set('plate')} /></Field>
          <Field label="Pago por entrega" hint="Vacío = el pago general de la flota">
            <input className="input" type="number" min="0" step="0.01" value={form.pay_per_delivery} onChange={set('pay_per_delivery')} />
          </Field>
          <Field label={driver ? 'Nueva contraseña' : 'Contraseña'} hint={driver ? 'Déjala vacía para no cambiarla' : 'Mínimo 8 caracteres'}>
            <input className="input" type="password" minLength={8} required={!driver} value={form.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
        </div>
        <Field label="Notas"><input className="input" value={form.notes} maxLength={500} onChange={set('notes')} /></Field>
        {driver && (
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Activo" /> Activo (puede entrar y recibir pedidos)
          </div>
        )}
        <Button type="submit" className="w-full" loading={saving}>Guardar</Button>
      </form>
    </Modal>
  );
}

interface CashRow { id: string; restaurant_name: string; order_folio: number; delivered_at: string; amount: string }
interface FleetCut { id: string; expected_cash: string; counted_cash: string; difference: string; deliveries_count: number; notes: string | null; created_at: string; created_by_name: string | null }

/** Corte de efectivo de un repartidor de la flota: entrega lo que cobró. */
function DriverCashModal({ driver, onClose }: { driver: FleetDriver; onClose: () => void }) {
  const [data, setData] = useState<{ pending: CashRow[]; expected_cash: number; cuts: FleetCut[] } | null>(null);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    platformApi<{ pending: CashRow[]; expected_cash: number; cuts: FleetCut[] }>(`/platform/fleet/drivers/${driver.id}/cash`)
      .then((d) => { setData(d); setCounted(String(d.expected_cash)); }).catch((e) => setError(errorMessage(e)));
  }, [driver.id]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await platformApi(`/platform/fleet/drivers/${driver.id}/cuts`, { method: 'POST', body: { counted_cash: Number(counted || 0), notes: notes || undefined } });
      setNotice('Corte registrado.');
      setNotes('');
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const diff = data ? Math.round((Number(counted || 0) - data.expected_cash) * 100) / 100 : 0;
  return (
    <Modal title={`Efectivo de ${driver.name}`} onClose={onClose} wide>
      {!data ? (error ? <Alert>{error}</Alert> : <Spinner />) : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {notice && <Alert kind="success">{notice}</Alert>}
          <p className="text-sm text-gray-300">Debe entregar <b className="text-xl text-white">{formatMXN(data.expected_cash)}</b> de {data.pending.length} entrega(s).</p>
          {data.pending.length > 0 && (
            <>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm text-gray-400">
                {data.pending.map((p) => (
                  <li key={p.id} className="flex justify-between"><span>{p.restaurant_name} #{p.order_folio} · {formatDateTime(p.delivered_at)}</span><span className="tabular-nums">{formatMXN(p.amount)}</span></li>
                ))}
              </ul>
              <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <Field label="Entrega"><input className="input" type="number" min="0" step="0.01" required value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
                <Field label="Notas"><input className="input" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></Field>
                <Button type="submit" loading={saving}>Registrar corte</Button>
              </form>
              {diff !== 0 && <p className={`text-sm ${diff < 0 ? 'text-red-300' : 'text-amber-300'}`}>{diff < 0 ? 'Faltante' : 'Sobrante'}: {formatMXN(Math.abs(diff))}</p>}
            </>
          )}
          <SectionTitle>Cortes anteriores</SectionTitle>
          <ul className="space-y-1 text-sm">
            {data.cuts.map((c) => (
              <li key={c.id} className="flex justify-between gap-2 text-gray-400">
                <span>{formatDateTime(c.created_at)} · {c.deliveries_count} entrega(s){c.created_by_name && ` · ${c.created_by_name}`}</span>
                <span className="tabular-nums">{formatMXN(c.counted_cash)}
                  {Number(c.difference) !== 0 && <span className={Number(c.difference) < 0 ? ' text-red-300' : ' text-amber-300'}> ({formatMXN(c.difference)})</span>}
                </span>
              </li>
            ))}
            {data.cuts.length === 0 && <li className="text-gray-500">Sin cortes todavía.</li>}
          </ul>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Liquidaciones a restaurantes
// ---------------------------------------------------------------------------

const METHOD_LABEL = { transferencia: 'Transferencia', efectivo: 'Efectivo', otro: 'Otro' } as const;

export function FleetLedgerTab() {
  const [rows, setRows] = useState<LedgerRestaurant[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<LedgerRestaurant | null>(null);

  const load = useCallback(() => {
    platformApi<{ restaurants: LedgerRestaurant[] }>('/platform/fleet/ledger').then((d) => setRows(d.restaurants)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  if (!rows) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <>
      <p className="mb-4 text-sm text-gray-400">
        El efectivo que cobra la flota se le paga al restaurante descontando las comisiones que quepan; las que no quepan se cobran en su siguiente factura mensual.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">Restaurante</th>
              <th className="px-4 py-3 font-medium">Comisión</th>
              <th className="px-4 py-3 text-right font-medium">Efectivo cobrado</th>
              <th className="px-4 py-3 text-right font-medium">Comisiones</th>
              <th className="px-4 py-3 text-right font-medium">A pagar hoy</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 text-gray-200">{r.name}
                  <span className="block text-xs text-gray-500">{r.mode === 'horom' ? 'Usa la flota' : r.horom_enabled ? 'Habilitado, usa propios' : 'Flota deshabilitada'}
                    {r.last_settlement && ` · última liquidación ${formatDateTime(r.last_settlement.created_at)}`}</span>
                </td>
                <td className="px-4 py-3 text-gray-400">{r.horom_fee_type === 'percent' ? `${Number(r.horom_fee_value)} %` : formatMXN(r.horom_fee_value)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(r.cash_pending)}<span className="block text-xs text-gray-500">{r.cash_deliveries} entrega(s)</span></td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(r.commission_pending)}<span className="block text-xs text-gray-500">{r.commission_deliveries} entrega(s)</span></td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">{formatMXN(r.payout_now)}</td>
                <td className="px-4 py-3 text-right"><Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setOpen(r)}>Ver</Button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Ningún restaurante tiene la flota habilitada. Habilítala en el detalle del restaurante.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <SettlementModal restaurant={open} onClose={() => { setOpen(null); load(); }} />}
    </>
  );
}

interface LedgerDetail {
  restaurant: { id: string; name: string };
  ledger: LedgerSummary & { payout: { cash_amount: number; commission_amount: number; net_amount: number } };
  settlements: Settlement[];
}

function SettlementModal({ restaurant, onClose }: { restaurant: LedgerRestaurant; onClose: () => void }) {
  const [data, setData] = useState<LedgerDetail | null>(null);
  const [method, setMethod] = useState<keyof typeof METHOD_LABEL>('transferencia');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    platformApi<LedgerDetail>(`/platform/fleet/ledger/${restaurant.id}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [restaurant.id]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await platformApi('/platform/fleet/settlements', {
        method: 'POST', body: { restaurant_id: restaurant.id, method, reference: reference || undefined, notes: notes || undefined },
      });
      setNotice('Liquidación registrada.');
      setReference('');
      setNotes('');
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Liquidación · ${restaurant.name}`} onClose={onClose} wide>
      {!data ? (error ? <Alert>{error}</Alert> : <Spinner />) : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {notice && <Alert kind="success">{notice}</Alert>}
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl bg-gray-800/60 p-3"><div className="text-gray-400">Efectivo</div><div className="text-lg font-semibold tabular-nums text-white">{formatMXN(data.ledger.payout.cash_amount)}</div></div>
            <div className="rounded-xl bg-gray-800/60 p-3"><div className="text-gray-400">Comisiones que se descuentan</div><div className="text-lg font-semibold tabular-nums text-white">-{formatMXN(data.ledger.payout.commission_amount)}</div></div>
            <div className="rounded-xl bg-brand/15 p-3"><div className="text-gray-300">Pagar al restaurante</div><div className="text-lg font-semibold tabular-nums text-white">{formatMXN(data.ledger.payout.net_amount)}</div></div>
          </div>
          {data.ledger.commission_pending > data.ledger.payout.commission_amount && (
            <p className="text-xs text-gray-500">
              {formatMXN(Math.round((data.ledger.commission_pending - data.ledger.payout.commission_amount) * 100) / 100)} de comisiones no caben en el efectivo y se cobrarán en la factura mensual.
            </p>
          )}
          {data.ledger.cash_deliveries + data.ledger.commission_deliveries > 0 && (
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <Field label="Forma de pago">
                <select className="input" value={method} onChange={(e) => setMethod(e.target.value as keyof typeof METHOD_LABEL)}>
                  {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Referencia"><input className="input" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} /></Field>
              <Field label="Notas"><input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
              <Button type="submit" className="sm:col-span-3" loading={saving}>Registrar liquidación</Button>
            </form>
          )}
          <SectionTitle>Historial</SectionTitle>
          <ul className="space-y-1 text-sm">
            {data.settlements.map((s) => (
              <li key={s.id} className="flex justify-between gap-2 text-gray-400">
                <span>{formatDateTime(s.created_at)} · {s.deliveries_count} entrega(s) · {METHOD_LABEL[s.method]}{s.reference && ` ${s.reference}`}</span>
                <span className="tabular-nums text-gray-200">{formatMXN(s.net_amount)}</span>
              </li>
            ))}
            {data.settlements.length === 0 && <li className="text-gray-500">Sin liquidaciones todavía.</li>}
          </ul>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reporte de pagos a repartidores
// ---------------------------------------------------------------------------

interface ReportRow { driver_id: string; name: string; active: boolean; deliveries: number; failed: number; driver_pay: string; cash_collected: string; commission: string }
interface Report { from: string; to: string; drivers: ReportRow[]; totals: { deliveries: number; driver_pay: number; cash_collected: number; commission: number } }

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function FleetReportTab() {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)));
  const [to, setTo] = useState(isoDay(today));
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    platformApi<Report>(`/platform/fleet/report?from=${from}&to=${to}`).then((d) => { setData(d); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, [from, to]);
  useEffect(load, [load]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Desde"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Repartidor</th>
                <th className="px-4 py-3 text-right font-medium">Entregas</th>
                <th className="px-4 py-3 text-right font-medium">No entregadas</th>
                <th className="px-4 py-3 text-right font-medium">Efectivo cobrado</th>
                <th className="px-4 py-3 text-right font-medium">Comisiones</th>
                <th className="px-4 py-3 text-right font-medium">A pagarle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.drivers.map((d) => (
                <tr key={d.driver_id} className={d.active ? '' : 'opacity-60'}>
                  <td className="px-4 py-3 text-gray-200">{d.name}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{d.deliveries}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-400">{d.failed}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMXN(d.cash_collected)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMXN(d.commission)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">{formatMXN(d.driver_pay)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-gray-700 font-semibold text-white">
              <tr>
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right tabular-nums">{data.totals.deliveries}</td>
                <td />
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(data.totals.cash_collected)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(data.totals.commission)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(data.totals.driver_pay)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ajustes de la flota
// ---------------------------------------------------------------------------

export function FleetSettingsTab() {
  const [settings, setSettings] = useState<FleetSettings | null>(null);
  const [pay, setPay] = useState('');
  const [seconds, setSeconds] = useState('');
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    platformApi<{ settings: FleetSettings }>('/platform/fleet/settings').then((d) => {
      setSettings(d.settings);
      setPay(String(d.settings.driver_pay_per_delivery));
      setSeconds(String(d.settings.offer_seconds));
      setAuto(d.settings.auto_offer);
    }).catch((e) => setError(errorMessage(e)));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const d = await platformApi<{ settings: FleetSettings }>('/platform/fleet/settings', {
        method: 'PUT', body: { driver_pay_per_delivery: Number(pay || 0), offer_seconds: Number(seconds), auto_offer: auto },
      });
      setSettings(d.settings);
      setNotice('Ajustes guardados.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <form onSubmit={submit} className="card max-w-xl space-y-4 p-6">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <Field label="Pago general por entrega" hint="Lo que gana el repartidor por cada entrega, salvo que tenga su propio pago.">
        <input className="input" type="number" min="0" step="0.01" required value={pay} onChange={(e) => setPay(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3 text-sm text-gray-300">
        <Toggle checked={auto} onChange={setAuto} label="Ofrecer automáticamente" />
        Ofrecer automáticamente cada solicitud nueva a los repartidores en turno y libres
      </div>
      <Field label="Duración de la oferta (segundos)" hint="De 15 a 3600. El primero que acepta se la lleva.">
        <input className="input" type="number" min="15" max="3600" required value={seconds} onChange={(e) => setSeconds(e.target.value)} />
      </Field>
      <Button type="submit" loading={saving}>Guardar</Button>
    </form>
  );
}
