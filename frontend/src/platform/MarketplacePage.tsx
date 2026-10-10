import { Bike, Check, MapPin, Plus, ShieldAlert, ShieldCheck, Store, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, PageHeader, Spinner, Toggle } from '../components/ui';
import type { Point } from '../components/ZoneMap';
import { errorMessage, platformApi } from '../lib/api';
import { formatDate, formatMXN } from '../lib/format';
import { DRIVER_STATUS_LABEL, DRIVER_STATUS_STYLE, type DriverStatus, type FeeTier } from '../marketplace/lib';

interface Settings {
  enabled: boolean; driver_share_pct: string; food_commission_pct: string; max_distance_km: string;
  driver_debt_limit: string; driver_max_radius_km: string;
}
interface Summary { pending_drivers: number; online_drivers: number; approved_drivers: number; published_listings: number; listings: number }
interface Driver {
  id: string; name: string; phone: string; email: string; vehicle: string | null; plate: string | null; on_duty: boolean;
  status: DriverStatus; self_registered: boolean; base: Point | null; radius_km: number | null; review_note: string | null; created_at: string;
}
interface PanelListing {
  restaurant_id: string; restaurant_name: string; slug: string; contact_phone: string | null; branch_id: string; branch_name: string;
  address: string | null; location: Point | null; cuisine: string | null; published: boolean; paused_until: string | null;
  blocked: boolean; blocked_reason: string | null; created_at: string;
}

const mapsLink = (p: Point) => `https://www.google.com/maps?q=${p.latitude},${p.longitude}`;

/**
 * Panel › Delivery: reglas de NeuronPOS Delivery (reparto del envio entre
 * repartidor y NeuronPOS, comision, distancias, tope de adeudo), la tabla de
 * envio por km, la aprobacion de repartidores y las fichas de restaurantes.
 */
export default function MarketplacePage() {
  const [data, setData] = useState<{ settings: Settings; fee_tiers: FeeTier[]; summary: Summary } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    platformApi<{ settings: Settings; fee_tiers: FeeTier[]; summary: Summary }>('/platform/marketplace/settings')
      .then(setData).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const s = data.summary;
  return (
    <>
      <PageHeader title="NeuronPOS Delivery" subtitle="Plataforma local de pedidos: sin mensualidad para restaurantes ni repartidores." />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Repartidores por aprobar" value={s.pending_drivers} warn={s.pending_drivers > 0} />
        <Tile label="Repartidores en turno" value={s.online_drivers} />
        <Tile label="Repartidores aprobados" value={s.approved_drivers} />
        <Tile label="Restaurantes publicados" value={`${s.published_listings} de ${s.listings}`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <SettingsCard settings={data.settings} onSaved={load} />
        <TiersCard tiers={data.fee_tiers} share={Number(data.settings.driver_share_pct)} onSaved={load} />
      </div>
      <DriversCard onChange={load} />
      <ListingsCard />
    </>
  );
}

function Tile({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`card px-4 py-3 ${warn ? 'border-amber-700/60' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold ${warn ? 'text-amber-300' : 'text-white'}`}>{value}</div>
    </div>
  );
}

function SettingsCard({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [f, setF] = useState({
    enabled: settings.enabled,
    share: String(Number(settings.driver_share_pct)),
    food: String(Number(settings.food_commission_pct)),
    maxKm: String(Number(settings.max_distance_km)),
    debt: String(Number(settings.driver_debt_limit)),
    radius: String(Number(settings.driver_max_radius_km)),
  });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setNotice(''); };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await platformApi('/platform/marketplace/settings', {
        method: 'PUT',
        body: {
          enabled: f.enabled, driver_share_pct: Number(f.share), food_commission_pct: Number(f.food),
          max_distance_km: Number(f.maxKm), driver_debt_limit: Number(f.debt), driver_max_radius_km: Number(f.radius),
        },
      });
      setNotice('Guardado');
      onSaved();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  const neuron = Math.max(0, 100 - Number(f.share || 0));
  return (
    <form onSubmit={save} className="card space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Reglas</h2>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <Toggle label="Delivery activo" checked={f.enabled} onChange={(v) => { setF({ ...f, enabled: v }); setNotice(''); }} />
          {f.enabled ? 'Activo' : 'Apagado'}
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Envío para el repartidor (%)" hint={`NeuronPOS se queda con el ${neuron} %`}>
          <input className="input" type="number" min={0} max={100} step={0.5} required value={f.share} onChange={set('share')} />
        </Field>
        <Field label="Comisión sobre la comida (%)" hint="0 = el restaurante recibe todo">
          <input className="input" type="number" min={0} max={50} step={0.5} required value={f.food} onChange={set('food')} />
        </Field>
        <Field label="Distancia máxima (km)" hint="Restaurante a cliente">
          <input className="input" type="number" min={0.5} max={50} step={0.5} required value={f.maxKm} onChange={set('maxKm')} />
        </Field>
        <Field label="Radio máximo del repartidor (km)">
          <input className="input" type="number" min={1} max={50} step={0.5} required value={f.radius} onChange={set('radius')} />
        </Field>
        <Field label="Tope de adeudo del repartidor" hint="Con este adeudo ya no toma pedidos en efectivo">
          <input className="input" type="number" min={0} step={10} required value={f.debt} onChange={set('debt')} />
        </Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center justify-end gap-2">
        {notice && <span className="text-sm text-emerald-300">{notice}</span>}
        <Button type="submit" loading={busy}>Guardar reglas</Button>
      </div>
    </form>
  );
}

function TiersCard({ tiers, share, onSaved }: { tiers: FeeTier[]; share: number; onSaved: () => void }) {
  const [rows, setRows] = useState(tiers.map((t) => ({ km: String(t.up_to_km), fee: String(t.fee) })));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const edit = (i: number, k: 'km' | 'fee', v: string) => { setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setNotice(''); };

  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await platformApi<{ fee_tiers: FeeTier[] }>('/platform/marketplace/fee-tiers', {
        method: 'PUT', body: { tiers: rows.map((x) => ({ up_to_km: Number(x.km), fee: Number(x.fee) })) },
      });
      setRows(r.fee_tiers.map((t) => ({ km: String(t.up_to_km), fee: String(t.fee) })));
      setNotice('Guardado');
      onSaved();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <section className="card space-y-3 p-5">
      <h2 className="font-semibold text-white">Costo de envío por distancia</h2>
      <p className="text-xs text-gray-500">En línea recta del restaurante al cliente. Más lejos que el último tramo no se puede pedir.</p>
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_1fr_1.4fr_auto] gap-2 text-xs text-gray-500">
          <span>Hasta (km)</span><span>Envío</span><span>Repartidor / NeuronPOS</span><span />
        </div>
        {rows.map((r, i) => {
          const fee = Number(r.fee || 0);
          const driver = Math.round(fee * share) / 100;
          return (
            <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr_auto] items-center gap-2">
              <input className="input" type="number" min={0.1} max={50} step={0.1} value={r.km} onChange={(e) => edit(i, 'km', e.target.value)} aria-label="Hasta km" />
              <input className="input" type="number" min={0} step={1} value={r.fee} onChange={(e) => edit(i, 'fee', e.target.value)} aria-label="Envío" />
              <span className="text-sm text-gray-300">{formatMXN(driver)} / {formatMXN(fee - driver)}</span>
              <button type="button" className="text-gray-500 hover:text-red-400 disabled:opacity-30" disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Quitar tramo"><Trash2 className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>
      {rows.length < 12 && (
        <Button type="button" variant="ghost" className="px-2" onClick={() => {
          const last = rows[rows.length - 1];
          setRows([...rows, { km: String(Number(last?.km || 0) + 2), fee: String(Number(last?.fee || 0) + 15) }]);
        }}><Plus className="h-4 w-4" /> Agregar tramo</Button>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center justify-end gap-2">
        {notice && <span className="text-sm text-emerald-300">{notice}</span>}
        <Button onClick={() => void save()} loading={busy}>Guardar tabla</Button>
      </div>
    </section>
  );
}

const FILTERS: { key: DriverStatus | ''; label: string }[] = [
  { key: 'pendiente', label: 'Por aprobar' }, { key: 'aprobado', label: 'Aprobados' }, { key: '', label: 'Todos' },
];

function DriversCard({ onChange }: { onChange: () => void }) {
  const [filter, setFilter] = useState<DriverStatus | ''>('pendiente');
  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    platformApi<{ drivers: Driver[] }>(`/platform/marketplace/drivers${filter ? `?status=${filter}` : ''}`)
      .then((r) => setDrivers(r.drivers)).catch((e) => setError(errorMessage(e)));
  }, [filter]);
  useEffect(load, [load]);

  async function review(d: Driver, status: 'aprobado' | 'rechazado' | 'bloqueado') {
    let note: string | null = null;
    if (status !== 'aprobado') {
      note = window.prompt(status === 'rechazado' ? `¿Por qué se rechaza a ${d.name}? (lo verá en su app)` : `¿Por qué se bloquea a ${d.name}? (lo verá en su app)`);
      if (!note) return;
    }
    setBusy(d.id);
    setError('');
    try {
      await platformApi(`/platform/marketplace/drivers/${d.id}/review`, { method: 'POST', body: { status, note } });
      load();
      onChange();
    } catch (e) { setError(errorMessage(e)); }
    setBusy('');
  }

  return (
    <section className="card mt-6 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-white"><Bike className="h-5 w-5 text-brand" /> Repartidores</h2>
        <div className="flex gap-1">
          {FILTERS.map((x) => (
            <button key={x.label} type="button" onClick={() => setFilter(x.key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${filter === x.key ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>{x.label}</button>
          ))}
        </div>
      </div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!drivers ? <Spinner /> : drivers.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">{filter === 'pendiente' ? 'No hay registros por aprobar.' : 'Sin repartidores.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="py-2">Repartidor</th><th>Vehículo</th><th>Zona</th><th>Registro</th><th>Estado</th><th className="text-right">Acciones</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {drivers.map((d) => (
                <tr key={d.id} className="align-top">
                  <td className="py-3 pr-3">
                    <div className="font-medium text-white">{d.name}</div>
                    <div className="text-xs text-gray-400">{d.phone} · {d.email}</div>
                  </td>
                  <td className="py-3 pr-3 text-gray-300">{d.vehicle || '—'}{d.plate && <div className="text-xs text-gray-500">{d.plate}</div>}</td>
                  <td className="py-3 pr-3 text-gray-300">
                    {d.base ? (
                      <a href={mapsLink(d.base)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline">
                        <MapPin className="h-3.5 w-3.5" /> {d.radius_km} km
                      </a>
                    ) : 'Sin zona'}
                  </td>
                  <td className="py-3 pr-3 text-gray-400">{formatDate(d.created_at)}{!d.self_registered && <div className="text-xs">Alta del Panel</div>}</td>
                  <td className="py-3 pr-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${DRIVER_STATUS_STYLE[d.status]}`}>{DRIVER_STATUS_LABEL[d.status]}</span>
                    {d.on_duty && <div className="mt-1 text-xs text-emerald-300">En turno</div>}
                    {d.review_note && d.status !== 'aprobado' && <div className="mt-1 max-w-[12rem] text-xs text-gray-500">{d.review_note}</div>}
                  </td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {d.status !== 'aprobado' && (
                        <Button className="px-3 py-1.5" loading={busy === d.id} onClick={() => void review(d, 'aprobado')}><Check className="h-4 w-4" /> Aprobar</Button>
                      )}
                      {d.status === 'pendiente' && (
                        <Button variant="ghost" className="px-3 py-1.5" disabled={busy === d.id} onClick={() => void review(d, 'rechazado')}><X className="h-4 w-4" /> Rechazar</Button>
                      )}
                      {d.status === 'aprobado' && (
                        <Button variant="ghost" className="px-3 py-1.5" disabled={busy === d.id} onClick={() => void review(d, 'bloqueado')}><ShieldAlert className="h-4 w-4" /> Bloquear</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ListingsCard() {
  const [rows, setRows] = useState<PanelListing[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    platformApi<{ listings: PanelListing[] }>('/platform/marketplace/listings').then((r) => setRows(r.listings)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  async function block(l: PanelListing, blocked: boolean) {
    const reason = blocked ? window.prompt(`¿Por qué se oculta ${l.restaurant_name}? (lo verá en su panel)`) : null;
    if (blocked && !reason) return;
    try {
      await platformApi(`/platform/marketplace/listings/${l.branch_id}/block`, { method: 'POST', body: { blocked, reason } });
      load();
    } catch (e) { setError(errorMessage(e)); }
  }

  return (
    <section className="card mt-6 p-5">
      <h2 className="mb-4 flex items-center gap-2 font-semibold text-white"><Store className="h-5 w-5 text-brand" /> Restaurantes</h2>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-gray-500">Aún no se registra ningún restaurante.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="py-2">Restaurante</th><th>Ubicación</th><th>Alta</th><th>Estado</th><th className="text-right" /></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((l) => (
                <tr key={l.branch_id}>
                  <td className="py-3 pr-3">
                    <div className="font-medium text-white">{l.restaurant_name}</div>
                    <div className="text-xs text-gray-400">{l.branch_name}{l.cuisine && ` · ${l.cuisine}`}{l.contact_phone && ` · ${l.contact_phone}`}</div>
                  </td>
                  <td className="py-3 pr-3 text-gray-300">
                    {l.location ? <a href={mapsLink(l.location)} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">{l.address || 'Ver mapa'}</a> : '—'}
                  </td>
                  <td className="py-3 pr-3 text-gray-400">{formatDate(l.created_at)}</td>
                  <td className="py-3 pr-3">
                    {l.blocked ? <span className="text-red-300">Bloqueado{l.blocked_reason && `: ${l.blocked_reason}`}</span>
                      : l.published ? <span className="text-emerald-300">Publicado</span> : <span className="text-gray-400">Sin publicar</span>}
                  </td>
                  <td className="py-3 text-right">
                    {l.blocked ? (
                      <Button variant="ghost" className="px-3 py-1.5" onClick={() => void block(l, false)}><ShieldCheck className="h-4 w-4" /> Desbloquear</Button>
                    ) : (
                      <Button variant="ghost" className="px-3 py-1.5" onClick={() => void block(l, true)}><ShieldAlert className="h-4 w-4" /> Ocultar</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
