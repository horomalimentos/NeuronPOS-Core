import {
  Banknote, Bike, Check, CircleSlash, LogOut, MapPin, Navigation, Phone, Power, RefreshCw, Store, Truck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AuthCard } from '../components/AuthCard';
import { PushBell } from '../components/PushBell';
import { Alert, Button, Field, Modal, Spinner, Toggle } from '../components/ui';
import { DELIVERY_STATUS_STYLE, NEXT_DRIVER_STEP, telHref, useLocationSharing, type GeoFix } from '../delivery/lib';
import type { DeliveryStatus, DriverJob, FleetOffer } from '../delivery/types';
import { ApiError, api, errorMessage, fleetApi } from '../lib/api';
import { applyBranding, resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import { disablePush } from '../lib/push';
import { session } from '../lib/session';
import { formatTime } from '../pos/lib';
import { useSite } from '../restaurant/useSite';

const POLL_MS = 15000;

type Kind = 'propio' | 'flota';

/**
 * App del repartidor (/repartidor), pensada para el celular. Sirve para los
 * repartidores del restaurante (usuarios con rol Repartidor) y para los de
 * la flota de NeuronPOS (login propio). Ve sus pedidos, abre la dirección en
 * Google Maps o Waze, llama al cliente, marca cada paso y, en turno,
 * comparte su ubicación cada ~20 s.
 */
export default function DriverApp() {
  const [kind, setKind] = useState<Kind | null>(() => (session.getToken('fleet') ? 'flota' : session.getToken('restaurant') ? 'propio' : null));
  const logout = async () => {
    if (kind === 'flota') session.setToken('fleet', null);
    else {
      await disablePush({ realm: 'restaurant' }).catch(() => {});
      session.setToken('restaurant', null);
    }
    setKind(null);
  };
  useEffect(() => { document.title = 'Repartidor'; }, []);
  if (!kind) return <DriverLogin onLogged={setKind} />;
  return <DriverHome kind={kind} onLogout={() => void logout()} />;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function DriverLogin({ onLogged }: { onLogged: (k: Kind) => void }) {
  const [tab, setTab] = useState<Kind>('propio');
  const { site, state } = useSite();
  const [slug, setSlug] = useState(session.getDevSlug() || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (tab === 'flota') resetBranding(); }, [tab]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (tab === 'flota') {
        const r = await fleetApi<{ token: string }>('/fleet/auth/login', { method: 'POST', body: { email, password }, noRedirect: true });
        session.setToken('fleet', r.token);
        session.setToken('restaurant', null);
      } else {
        const r = await api<{ token: string; user: { role: string } }>('/auth/login', { method: 'POST', body: { email, password }, noRedirect: true });
        if (r.user.role !== 'repartidor') throw new Error('Esta app es para repartidores. Entra al sistema desde /admin.');
        session.setToken('restaurant', r.token);
        session.setToken('fleet', null);
      }
      onLogged(tab);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const needsSlug = tab === 'propio' && state === 'not_found';
  return (
    <AuthCard
      title={tab === 'propio' ? (site?.restaurant.name || 'Repartidor') : 'Flota NeuronPOS'}
      subtitle="Entra para ver tus entregas"
      logo={<div className="mb-5 rounded-2xl bg-brand/15 p-3 text-brand">{tab === 'propio' ? <Bike className="h-9 w-9" /> : <Truck className="h-9 w-9" />}</div>}
    >
      <div className="mb-5 grid grid-cols-2 gap-2">
        {(['propio', 'flota'] as const).map((k) => (
          <button key={k} type="button" onClick={() => { setTab(k); setError(''); }}
            className={`rounded-xl border px-3 py-2 text-sm transition ${tab === k ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 text-gray-400'}`}>
            {k === 'propio' ? 'Del restaurante' : 'Flota NeuronPOS'}
          </button>
        ))}
      </div>
      {needsSlug ? (
        <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); session.setDevSlug(slug.trim().toLowerCase() || null); window.location.reload(); }}>
          <Field label="Restaurante" hint="El identificador de tu restaurante (ej. mirestaurante)">
            <input className="input" required value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full">Continuar</Button>
        </form>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {error && <Alert>{error}</Alert>}
          <Field label="Correo">
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Contraseña">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" loading={loading} className="w-full">Entrar</Button>
        </form>
      )}
    </AuthCard>
  );
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

interface OwnRow {
  id: string; status: DeliveryStatus; status_label: string; folio: number; customer_name: string | null; customer_phone: string | null;
  customer_address: string | null; delivery_reference: string | null; notes: string | null; total: string; remaining: number;
  pay_with: string | null; cash_collected: string; maps_url: string | null; waze_url: string | null; fail_reason: string | null;
  delivered_at: string | null; branch_name: string; branch_address: string | null; branch_phone: string | null;
  items: { name: string; quantity: number; notes: string | null }[];
}

interface FleetRow {
  id: string; status: DeliveryStatus; status_label: string; restaurant_name: string; order_folio: number; pickup_name: string;
  pickup_address: string | null; pickup_phone: string | null; customer_name: string; customer_phone: string | null;
  dropoff_address: string; dropoff_reference: string | null; notes: string | null; order_total: string; cash_to_collect: string;
  pay_with: string | null; cash_collected: string; maps_url: string | null; waze_url: string | null; fail_reason: string | null;
  delivered_at: string | null;
}

const fromOwn = (r: OwnRow): DriverJob => ({
  id: r.id, status: r.status, status_label: r.status_label, folio: r.folio, pickup_name: r.branch_name,
  pickup_address: r.branch_address, pickup_phone: r.branch_phone, customer_name: r.customer_name, customer_phone: r.customer_phone,
  address: r.customer_address, reference: r.delivery_reference, notes: r.notes, total: r.total, to_collect: Number(r.remaining),
  pay_with: r.pay_with, cash_collected: r.cash_collected, maps_url: r.maps_url, waze_url: r.waze_url, items: r.items,
  fail_reason: r.fail_reason, delivered_at: r.delivered_at,
});

const fromFleet = (r: FleetRow): DriverJob => ({
  id: r.id, status: r.status, status_label: r.status_label, folio: r.order_folio, restaurant_name: r.restaurant_name,
  pickup_name: r.pickup_name, pickup_address: r.pickup_address, pickup_phone: r.pickup_phone, customer_name: r.customer_name,
  customer_phone: r.customer_phone, address: r.dropoff_address, reference: r.dropoff_reference, notes: r.notes,
  total: r.order_total, to_collect: Number(r.cash_to_collect), pay_with: r.pay_with, cash_collected: r.cash_collected,
  maps_url: r.maps_url, waze_url: r.waze_url, items: [], fail_reason: r.fail_reason, delivered_at: r.delivered_at,
});

function DriverHome({ kind, onLogout }: { kind: Kind; onLogout: () => void }) {
  const fleet = kind === 'flota';
  const call = useMemo(() => (fleet ? fleetApi : api), [fleet]);
  const base = fleet ? '/fleet' : '/delivery/driver';
  const [name, setName] = useState('');
  const [push, setPush] = useState(false);
  const [jobs, setJobs] = useState<DriverJob[] | null>(null);
  const [offers, setOffers] = useState<FleetOffer[]>([]);
  const [onDuty, setOnDuty] = useState(false);
  const [cash, setCash] = useState(0);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState<{ job: DriverJob; mode: 'entregado' | 'fallido' } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      if (fleet) {
        const [me, reqs, offs] = await Promise.all([
          fleetApi<{ driver: { name: string; on_duty: boolean }; cash_pending: string }>('/fleet/me'),
          fleetApi<{ requests: FleetRow[] }>('/fleet/requests'),
          fleetApi<{ offers: FleetOffer[] }>('/fleet/offers'),
        ]);
        setName(me.driver.name);
        setOnDuty(me.driver.on_duty);
        setCash(Number(me.cash_pending));
        setJobs(reqs.requests.map(fromFleet));
        setOffers(offs.offers);
      } else {
        const r = await api<{ deliveries: OwnRow[]; on_duty: boolean; cash_pending: string }>('/delivery/driver/deliveries');
        setJobs(r.deliveries.map(fromOwn));
        setOnDuty(r.on_duty);
        setCash(Number(r.cash_pending));
      }
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.code === 'ROLE_REQUIRED') {
        setError('Tu usuario no es repartidor.');
        setJobs([]);
      } else setError(errorMessage(e));
    }
  }, [fleet]);

  useEffect(() => {
    if (fleet) resetBranding();
    else {
      api<{ user: { name: string }; restaurant: { primary_color: string; secondary_color: string; name: string }; modules: { code: string; enabled: boolean }[] }>('/me')
        .then((m) => {
          setName(m.user.name);
          setPush(m.modules.some((x) => x.code === 'push' && x.enabled));
          applyBranding(m.restaurant.primary_color, m.restaurant.secondary_color);
        })
        .catch(() => {});
    }
  }, [fleet]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const sendLocation = useCallback((fix: GeoFix) => call(`${base}/location`, { method: 'POST', body: fix }), [call, base]);
  const geo = useLocationSharing(onDuty, sendLocation);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy('');
    }
  }

  const setStatus = (job: DriverJob, status: DeliveryStatus, extra: Record<string, unknown> = {}) =>
    act(`${job.id}:${status}`, () => call(`${base}/${fleet ? 'requests' : 'deliveries'}/${job.id}/status`, { method: 'POST', body: { status, ...extra } }));

  const toggleDuty = (v: boolean) => act('duty', async () => {
    await call(`${base}/duty`, { method: 'POST', body: { on_duty: v } });
    setOnDuty(v);
  });

  const active = (jobs || []).filter((j) => ['asignado', 'recogido', 'en_camino'].includes(j.status));
  const done = (jobs || []).filter((j) => !['asignado', 'recogido', 'en_camino'].includes(j.status));

  return (
    <div className="mx-auto min-h-screen max-w-lg pb-10">
      <header className="sticky top-0 z-30 border-b border-gray-800 bg-gray-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-semibold text-white">{fleet ? <Truck className="h-5 w-5 text-brand" /> : <Bike className="h-5 w-5 text-brand" />} {name || 'Repartidor'}</div>
            <div className="text-xs text-gray-500">{fleet ? 'Flota NeuronPOS' : 'Repartidor del restaurante'}</div>
          </div>
          <div className="flex items-center gap-3">
            {push && <PushBell target={{ realm: 'restaurant' }} className="[&_svg]:h-5 [&_svg]:w-5" />}
            <button onClick={() => void load()} className="text-gray-400 hover:text-white" aria-label="Actualizar"><RefreshCw className="h-5 w-5" /></button>
            <button onClick={onLogout} className="text-gray-400 hover:text-white" aria-label="Salir"><LogOut className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-gray-900 px-3 py-2">
          <span className="flex items-center gap-2 text-sm text-gray-200">
            <Power className={`h-4 w-4 ${onDuty ? 'text-emerald-400' : 'text-gray-500'}`} />
            {onDuty ? 'En turno · compartiendo ubicación' : 'Fuera de turno'}
          </span>
          <Toggle checked={onDuty} onChange={toggleDuty} disabled={busy === 'duty'} label="En turno" />
        </div>
        {onDuty && geo.error && <p className="mt-2 text-xs text-amber-300">{geo.error}</p>}
        {onDuty && !geo.error && geo.lastSent && <p className="mt-1 text-xs text-gray-500">Ubicación enviada a las {formatTime(geo.lastSent.toISOString())}</p>}
      </header>

      <main className="space-y-4 px-4 pt-4">
        {error && <Alert>{error}</Alert>}
        {cash > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            <Banknote className="h-5 w-5" /> Traes {formatMXN(cash)} en efectivo por entregar{fleet ? ' a NeuronPOS' : ' en caja'}.
          </div>
        )}

        {offers.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">Pedidos disponibles</h2>
            <div className="space-y-3">
              {offers.map((o) => (
                <article key={o.id} className="card border-violet-700/60 p-4">
                  <div className="font-semibold text-white">{o.summary.restaurant_name}</div>
                  <p className="text-sm text-gray-400">Recoger en {o.summary.pickup_name}{o.summary.pickup_address && ` · ${o.summary.pickup_address}`}</p>
                  {o.summary.dropoff_area && <p className="text-sm text-gray-400">Entregar en: {o.summary.dropoff_area}</p>}
                  {Number(o.summary.cash_to_collect) > 0 && <p className="mt-1 text-sm text-amber-300">Cobrar {formatMXN(o.summary.cash_to_collect)}</p>}
                  <p className="mt-1 text-xs text-gray-500">Disponible hasta las {formatTime(o.expires_at)}</p>
                  <div className="mt-3 flex gap-2">
                    <Button className="flex-1" loading={busy === `offer:${o.id}`} onClick={() => act(`offer:${o.id}`, () => fleetApi(`/fleet/offers/${o.id}/accept`, { method: 'POST' }))}>Aceptar</Button>
                    <Button variant="secondary" onClick={() => act(`decline:${o.id}`, () => fleetApi(`/fleet/offers/${o.id}/decline`, { method: 'POST' }))}>No puedo</Button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">Mis entregas</h2>
          {!jobs ? <Spinner /> : active.length === 0 ? (
            <p className="card p-6 text-center text-sm text-gray-500">
              No tienes pedidos asignados.{!onDuty && ' Activa "En turno" para que te asignen pedidos.'}
            </p>
          ) : (
            <div className="space-y-3">
              {active.map((j) => (
                <JobCard key={j.id} job={j} fleet={fleet} busy={busy}
                  onNext={(status) => (status === 'entregado' ? setFinishing({ job: j, mode: 'entregado' }) : setStatus(j, status))}
                  onFail={() => setFinishing({ job: j, mode: 'fallido' })} />
              ))}
            </div>
          )}
        </section>

        {done.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">Terminadas hoy</h2>
            <ul className="card divide-y divide-gray-800">
              {done.map((j) => (
                <li key={j.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="text-gray-300">#{j.folio} · {j.customer_name}{j.restaurant_name && <span className="text-gray-500"> · {j.restaurant_name}</span>}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${DELIVERY_STATUS_STYLE[j.status]}`}>{j.status_label}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {finishing && (
        <FinishSheet job={finishing.job} mode={finishing.mode} fleet={fleet} onClose={() => setFinishing(null)}
          onConfirm={async (extra) => {
            const ok = await setStatus(finishing.job, finishing.mode, extra);
            if (ok) setFinishing(null);
          }} />
      )}
    </div>
  );
}

function JobCard({ job: j, fleet, busy, onNext, onFail }: {
  job: DriverJob; fleet: boolean; busy: string; onNext: (s: DeliveryStatus) => void; onFail: () => void;
}) {
  const next = NEXT_DRIVER_STEP[j.status];
  return (
    <article className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold text-white">#{j.folio} · {j.customer_name || 'Cliente'}</div>
          {fleet && j.restaurant_name && <div className="text-xs text-gray-500">{j.restaurant_name}</div>}
        </div>
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${DELIVERY_STATUS_STYLE[j.status]}`}>{j.status_label}</span>
      </div>

      {j.status === 'asignado' && (
        <div className="mt-3 rounded-xl bg-gray-800/60 p-3 text-sm">
          <div className="flex items-center gap-2 text-gray-200"><Store className="h-4 w-4 text-gray-400" /> Recoger en {j.pickup_name}</div>
          {j.pickup_address && <p className="ml-6 text-gray-400">{j.pickup_address}</p>}
          {j.pickup_phone && <a href={telHref(j.pickup_phone)} className="ml-6 text-brand">{j.pickup_phone}</a>}
        </div>
      )}

      {j.address && (
        <div className="mt-3 flex items-start gap-2 text-sm text-gray-200">
          <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
          <span>{j.address}{j.reference && <span className="block text-gray-400">{j.reference}</span>}</span>
        </div>
      )}
      {j.notes && <p className="mt-2 text-sm italic text-gray-400">“{j.notes}”</p>}
      {j.items.length > 0 && <p className="mt-2 text-xs text-gray-500">{j.items.map((i) => `${i.quantity}× ${i.name}`).join(' · ')}</p>}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <a href={j.maps_url || undefined} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-1 rounded-xl border border-gray-700 py-2 text-xs text-gray-200 hover:bg-gray-800"><MapPin className="h-5 w-5" /> Maps</a>
        <a href={j.waze_url || undefined} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-1 rounded-xl border border-gray-700 py-2 text-xs text-gray-200 hover:bg-gray-800"><Navigation className="h-5 w-5" /> Waze</a>
        <a href={telHref(j.customer_phone)} className={`flex flex-col items-center gap-1 rounded-xl border border-gray-700 py-2 text-xs text-gray-200 hover:bg-gray-800 ${j.customer_phone ? '' : 'pointer-events-none opacity-40'}`}><Phone className="h-5 w-5" /> Llamar</a>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-gray-800/60 px-3 py-2 text-sm">
        {j.to_collect > 0
          ? <span className="text-amber-300">Cobrar <b className="text-lg">{formatMXN(j.to_collect)}</b>{j.pay_with && <span className="block text-xs text-gray-400">Paga con {formatMXN(j.pay_with)} · cambio {formatMXN(Math.max(0, Number(j.pay_with) - j.to_collect))}</span>}</span>
          : <span className="text-emerald-300">Ya está pagado: no cobres</span>}
      </div>

      <div className="mt-3 flex gap-2">
        {next && (
          <Button className="flex-1 py-3 text-base" loading={busy === `${j.id}:${next.status}`} onClick={() => onNext(next.status)}>
            <Check className="h-5 w-5" /> {next.label}
          </Button>
        )}
        {['recogido', 'en_camino'].includes(j.status) && (
          <Button variant="secondary" onClick={onFail} aria-label="No se pudo entregar"><CircleSlash className="h-5 w-5" /></Button>
        )}
      </div>
    </article>
  );
}

function FinishSheet({ job, mode, fleet, onClose, onConfirm }: {
  job: DriverJob; mode: 'entregado' | 'fallido'; fleet: boolean; onClose: () => void; onConfirm: (extra: Record<string, unknown>) => void;
}) {
  const [received, setReceived] = useState(job.pay_with ? String(Number(job.pay_with)) : String(job.to_collect));
  const [tip, setTip] = useState('');
  const [reason, setReason] = useState('');
  const change = Math.max(0, Math.round((Number(received || 0) - job.to_collect - Number(tip || 0)) * 100) / 100);
  if (mode === 'fallido') {
    return (
      <Modal title="No se pudo entregar" onClose={onClose}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onConfirm({ reason }); }}>
          <Field label="¿Qué pasó?"><input className="input" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. no contesta, dirección incorrecta" /></Field>
          <Button type="submit" variant="danger" className="w-full">Avisar al restaurante</Button>
        </form>
      </Modal>
    );
  }
  return (
    <Modal title={`Entregar #${job.folio}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onConfirm(job.to_collect > 0 && !fleet ? { received: Number(received || 0), tip: Number(tip || 0) } : {}); }}>
        {job.to_collect > 0 ? (
          <>
            <p className="text-sm text-gray-300">Cobra en efectivo <b className="text-2xl text-white">{formatMXN(job.to_collect)}</b></p>
            {!fleet && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Te dio"><input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} /></Field>
                <Field label="Propina"><input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={tip} onChange={(e) => setTip(e.target.value)} placeholder="0" /></Field>
              </div>
            )}
            {!fleet && <p className="text-sm text-gray-400">Cambio: <b className="text-white">{formatMXN(change)}</b></p>}
          </>
        ) : <p className="text-sm text-emerald-300">El pedido ya está pagado: solo entrégalo.</p>}
        <Button type="submit" className="w-full py-3 text-base"><Check className="h-5 w-5" /> Confirmar entrega</Button>
      </form>
    </Modal>
  );
}
