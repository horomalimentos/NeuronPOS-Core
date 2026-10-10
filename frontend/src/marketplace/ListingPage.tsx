import { Check, AlertCircle, Clock, Eye, EyeOff, PauseCircle, PlayCircle, ShieldAlert, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';
import { Alert, Button, Field, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';
import type { Listing } from './lib';

/**
 * Ficha del restaurante en NeuronPOS Delivery (modulo marketplace): por
 * sucursal, ubicacion, descripcion, tiempo de preparacion y pedido minimo;
 * publicar u ocultar y pausar pedidos un rato. Para publicar hacen falta
 * ubicacion, horario y al menos un producto en el menu.
 */
export default function ListingPage() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ listings: Listing[] }>('/marketplace/listings').then((r) => setListings(r.listings)).catch((e) => setError(errorMessage(e)));
  }, []);
  const replace = (l: Listing) => setListings((all) => (all || []).map((x) => (x.branch_id === l.branch_id ? l : x)));

  return (
    <>
      <PageHeader title="NeuronPOS Delivery" subtitle="Tu restaurante en la plataforma de pedidos local. Sin mensualidad." />
      {error && <Alert>{error}</Alert>}
      {!listings ? (!error && <Spinner />) : (
        <div className="space-y-6">
          {listings.map((l) => <ListingCard key={l.branch_id} listing={l} onChange={replace} />)}
        </div>
      )}
    </>
  );
}

function stateOf(l: Listing): { label: string; style: string } {
  if (l.blocked) return { label: 'Bloqueado por NeuronPOS', style: 'bg-red-500/15 text-red-300 ring-red-500/40' };
  if (!l.published) return { label: 'Sin publicar', style: 'bg-gray-500/15 text-gray-300 ring-gray-500/40' };
  if (l.paused_until) return { label: `En pausa hasta las ${formatTime(l.paused_until)}`, style: 'bg-amber-500/15 text-amber-300 ring-amber-500/40' };
  if (!l.visible) return { label: 'Publicado, pero incompleto', style: 'bg-amber-500/15 text-amber-300 ring-amber-500/40' };
  return { label: 'Visible para los clientes', style: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40' };
}

function ListingCard({ listing: l, onChange }: { listing: Listing; onChange: (l: Listing) => void }) {
  const [location, setLocation] = useState<Point | null>(l.location);
  const [form, setForm] = useState({
    cuisine: l.cuisine || '', description: l.description || '', prep: String(l.prep_minutes), minOrder: String(Number(l.min_order)),
  });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState('');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [k]: e.target.value }); setSaved(false); };
  const state = stateOf(l);

  const run = async (key: string, fn: () => Promise<{ listing: Listing }>) => {
    setBusy(key);
    setError('');
    try {
      const r = await fn();
      onChange(r.listing);
      if (key === 'save') setSaved(true);
    } catch (e) { setError(errorMessage(e)); }
    setBusy('');
  };
  const put = (body: Record<string, unknown>) => api<{ listing: Listing }>(`/marketplace/listings/${l.branch_id}`, { method: 'PUT', body });
  const save = () => run('save', () => put({
    location: location ?? undefined, cuisine: form.cuisine || null, description: form.description || null,
    prep_minutes: Number(form.prep), min_order: Number(form.minOrder || 0),
  }));
  const pause = (minutes: number) => run(`pause${minutes}`, () => api<{ listing: Listing }>(`/marketplace/listings/${l.branch_id}/pause`, { method: 'POST', body: { minutes } }));

  const steps = [
    { ok: !l.missing.includes('ubicacion'), label: 'Ubicación en el mapa', hint: 'Abajo, en esta misma ficha' },
    { ok: !l.missing.includes('horario'), label: 'Horario', hint: 'Sucursales › Horario', to: '/admin/sucursales' },
    { ok: !l.missing.includes('menu'), label: l.products ? `Menú (${l.products} productos)` : 'Menú', hint: 'Sube al menos un producto', to: '/admin/menu' },
  ];

  return (
    <section className="card space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Store className="h-5 w-5 text-brand" /> {l.branch_name}</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${state.style}`}>{state.label}</span>
      </div>

      {l.blocked && (
        <Alert><span className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> {l.blocked_reason || 'NeuronPOS ocultó tu restaurante.'} Comunícate con NeuronPOS.</span></Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {steps.map((s) => (
          <div key={s.label} className={`rounded-xl border px-3 py-2.5 text-sm ${s.ok ? 'border-emerald-800/60 bg-emerald-950/30' : 'border-amber-800/60 bg-amber-950/30'}`}>
            <div className={`flex items-center gap-2 font-medium ${s.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
              {s.ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {s.label}
            </div>
            {!s.ok && (s.to ? <Link to={s.to} className="text-xs text-gray-300 underline">{s.hint}</Link> : <span className="text-xs text-gray-400">{s.hint}</span>)}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {l.published ? (
          <Button variant="secondary" loading={busy === 'pub'} onClick={() => void run('pub', () => put({ published: false }))}>
            <EyeOff className="h-4 w-4" /> Ocultar
          </Button>
        ) : (
          <Button loading={busy === 'pub'} disabled={l.missing.length > 0} onClick={() => void run('pub', () => put({ published: true }))}>
            <Eye className="h-4 w-4" /> Publicar en Delivery
          </Button>
        )}
        {l.published && (l.paused_until ? (
          <Button variant="secondary" loading={busy === 'pause0'} onClick={() => void pause(0)}><PlayCircle className="h-4 w-4" /> Reanudar pedidos</Button>
        ) : (
          <>
            <span className="ml-2 flex items-center gap-1 text-sm text-gray-400"><PauseCircle className="h-4 w-4" /> Pausar:</span>
            {[15, 30, 60].map((m) => (
              <Button key={m} variant="ghost" className="px-3" loading={busy === `pause${m}`} onClick={() => void pause(m)}>{m} min</Button>
            ))}
          </>
        ))}
      </div>

      <div className="grid gap-5 border-t border-gray-800 pt-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-300">Ubicación</p>
          <MapTools onPoint={(p) => { setLocation(p); setSaved(false); }} near={location} initialQuery={l.address || ''} />
          <ZoneMap className="h-64" center={null} tiers={[]} pin={location} onPick={(p) => { setLocation(p); setSaved(false); }} />
          <p className="text-xs text-gray-500">Los clientes ven tu restaurante si un repartidor conectado cubre este punto.</p>
        </div>
        <div className="space-y-4">
          <Field label="Tipo de comida"><input className="input" maxLength={60} value={form.cuisine} onChange={set('cuisine')} /></Field>
          <Field label="Descripción" hint="Lo que ve el cliente debajo de tu nombre">
            <textarea className="input min-h-[80px]" maxLength={500} value={form.description} onChange={set('description')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Preparación (min)">
              <input className="input" type="number" min={5} max={180} value={form.prep} onChange={set('prep')} />
            </Field>
            <Field label="Pedido mínimo">
              <input className="input" type="number" min={0} step={1} value={form.minOrder} onChange={set('minOrder')} />
            </Field>
          </div>
          <p className="flex items-center gap-1 text-xs text-gray-500">
            <Clock className="h-3.5 w-3.5" /> {form.prep} min de preparación{Number(form.minOrder) > 0 && ` · mínimo ${formatMXN(form.minOrder)}`}
          </p>
          {error && <Alert>{error}</Alert>}
          <div className="flex items-center justify-end gap-2">
            {saved && <span className="text-sm text-emerald-300">Guardado</span>}
            <Button loading={busy === 'save'} onClick={() => void save()}>Guardar ficha</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
