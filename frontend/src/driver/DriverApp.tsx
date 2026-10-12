import InstallApp from '../components/InstallApp';
import {
  Bike, Check, ChevronUp, History, LocateFixed, MapPin, Menu, Power, Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthCard } from '../components/AuthCard';
import { NayoLogo } from '../components/NayoLogo';
import { PushBell, PushFab } from '../components/PushBell';
import { Alert, Button, Field, Modal } from '../components/ui';
import { useLocationSharing, type GeoFix } from '../delivery/lib';
import type { DeliveryStatus, DriverJob, FleetOffer } from '../delivery/types';
import { ApiError, api, errorMessage, fleetApi } from '../lib/api';
import { applyBranding, resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import { disablePush } from '../lib/push';
import { session } from '../lib/session';
import { DRIVER_STATUS_LABEL, type DriverStatus, type MarketplaceInfo } from '../marketplace/lib';
import { nayoPath, onNayoHost } from '../marketplace/nayoUrl';
import ZoneFields from '../marketplace/ZoneFields';
import { useSite } from '../restaurant/useSite';
import type { Point } from '../components/ZoneMap';
import DriverMap, { type Pin } from './DriverMap';
import OfferCard from './OfferCard';
import { Drawer, Earnings, TodayHistory } from './Panels';
import TripCard from './TripCard';
import { ACTIVE_JOB, fromJob, fromNayo, offerKey, type AnyOffer, type NayoBoard, type Trip } from './trips';

/** Datos del repartidor de Nayo (GET /fleet/me). */
interface FleetMe {
  id: string; name: string; on_duty: boolean; status: DriverStatus; self_registered: boolean;
  base: Point | null; radius_km: number | null; review_note: string | null;
}

type Kind = 'propio' | 'flota';

/**
 * App del repartidor (/repartidor), pensada para el celular y con el look de
 * Uber, Rappi o DiDi: mapa a pantalla completa, boton grande de Conectarse,
 * pedidos nuevos en una tarjeta con lo que ganas, el pedido en curso abajo
 * con navegar, llamar y chat, y un boton deslizable para cada paso. Sirve
 * para los repartidores de Nayo (login propio) y para los del restaurante
 * (usuarios con rol Repartidor).
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
  useEffect(() => { document.title = kind === 'propio' ? 'Repartidor' : 'Nayo · Repartidor'; }, [kind]);
  if (!kind) return <DriverLogin onLogged={setKind} />;
  return <DriverHome kind={kind} onLogout={() => void logout()} />;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function DriverLogin({ onLogged }: { onLogged: (k: Kind) => void }) {
  const nayoHost = onNayoHost();
  const [picked, setPicked] = useState<Kind | null>(null);
  const { site, state } = useSite();
  // En elnayo.com y en neuronpos.app (sin restaurante) se entra a Nayo.
  const tab: Kind = nayoHost ? 'flota' : picked ?? (state === 'ok' ? 'propio' : 'flota');
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

  return (
    <AuthCard
      title={tab === 'propio' ? (site?.restaurant.name || 'Repartidor') : 'Reparte con Nayo'}
      subtitle={tab === 'propio' ? 'Entra para ver tus entregas' : 'Entra para conectarte y recibir pedidos'}
      logo={tab === 'propio'
        ? <div className="mb-5 rounded-2xl bg-brand/15 p-3 text-brand"><Bike className="h-9 w-9" /></div>
        : <NayoLogo size="md" className="mb-6" />}
    >
      {/* Los repartidores de un restaurante solo entran desde el sitio de su restaurante. */}
      {!nayoHost && state === 'ok' && (
        <div className="mb-5 grid grid-cols-2 gap-2">
          {(['flota', 'propio'] as const).map((k) => (
            <button key={k} type="button" onClick={() => { setPicked(k); setError(''); }}
              className={`rounded-xl border px-3 py-2 text-sm transition ${tab === k ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 text-gray-400'}`}>
              {k === 'propio' ? 'Del restaurante' : 'Nayo'}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <Field label="Correo">
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Contraseña">
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" loading={loading} className="w-full py-3 text-base">Entrar</Button>
        {tab === 'flota' && (
          <div className="space-y-2 text-center text-sm text-gray-400">
            <p>¿Todavía no repartes con Nayo? <Link to={nayoPath('/repartidores')} className="font-semibold text-brand">Regístrate gratis</Link></p>
          </div>
        )}
      </form>
    </AuthCard>
  );
}

// ---------------------------------------------------------------------------
// Pantalla principal
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

/** Aviso de pedido nuevo: vibra y suena un "ding" corto. */
function ding() {
  try { navigator.vibrate?.([250, 120, 250]); } catch { /* sin vibracion */ }
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.18].forEach((at, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.17);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch { /* sin audio */ }
}

function DriverHome({ kind, onLogout }: { kind: Kind; onLogout: () => void }) {
  const fleet = kind === 'flota';
  const call = useMemo(() => (fleet ? fleetApi : api), [fleet]);
  const base = fleet ? '/fleet' : '/delivery/driver';
  const [name, setName] = useState('');
  const [restaurant, setRestaurant] = useState('');
  const [push, setPush] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [jobs, setJobs] = useState<DriverJob[]>([]);
  const [fleetOffers, setFleetOffers] = useState<FleetOffer[]>([]);
  const [board, setBoard] = useState<NayoBoard | null>(null);
  const [onDuty, setOnDuty] = useState(false);
  const [cash, setCash] = useState(0);
  const [fleetToday, setFleetToday] = useState(0);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState<{ job: DriverJob; mode: 'entregado' | 'fallido' } | null>(null);
  const [busy, setBusy] = useState('');
  const [fleetMe, setFleetMe] = useState<FleetMe | null>(null);
  const [view, setView] = useState<'home' | 'earnings' | 'history' | 'zone'>('home');
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState('');
  const [skipped, setSkipped] = useState<string[]>([]);
  const [offersOpen, setOffersOpen] = useState(false);
  const [fit, setFit] = useState(0);
  const approved = !fleet || !fleetMe || fleetMe.status === 'aprobado';
  const needsZone = fleet && !!fleetMe && fleetMe.self_registered && !fleetMe.base;
  const back = new URLSearchParams(window.location.search).get('pago');

  const load = useCallback(async () => {
    try {
      if (fleet) {
        const [me, reqs, offs, b] = await Promise.all([
          fleetApi<{ driver: FleetMe; cash_pending: string; today: { pay: string } }>('/fleet/me'),
          fleetApi<{ requests: FleetRow[] }>('/fleet/requests'),
          fleetApi<{ offers: FleetOffer[] }>('/fleet/offers'),
          fleetApi<NayoBoard>('/fleet/marketplace').catch(() => null),
        ]);
        setName(me.driver.name);
        setFleetMe(me.driver);
        setOnDuty(me.driver.on_duty);
        setCash(Number(me.cash_pending));
        setFleetToday(Number(me.today?.pay ?? 0));
        setJobs(reqs.requests.map(fromFleet));
        setFleetOffers(offs.offers);
        setBoard(b);
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
    } finally {
      setLoaded(true);
    }
  }, [fleet]);

  useEffect(() => {
    if (fleet) resetBranding();
    else {
      api<{ user: { name: string }; restaurant: { primary_color: string; secondary_color: string; name: string }; modules: { code: string; enabled: boolean }[] }>('/me')
        .then((m) => {
          setName(m.user.name);
          setRestaurant(m.restaurant.name);
          setPush(m.modules.some((x) => x.code === 'push' && x.enabled));
          applyBranding(m.restaurant.primary_color, m.restaurant.secondary_color);
        })
        .catch(() => {});
    }
  }, [fleet]);

  // Conectado se revisa mas seguido para que los pedidos nuevos lleguen pronto.
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, onDuty ? 8000 : 20000);
    return () => clearInterval(t);
  }, [load, onDuty]);

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
      await load();
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
    if (v) setFit((n) => n + 1);
  });

  // Pedidos en curso: los de Nayo primero, luego los de la flota o del restaurante.
  const trips = useMemo<Trip[]>(() => [
    ...(board?.active ?? []).map(fromNayo),
    ...jobs.filter((j) => ACTIVE_JOB.includes(j.status)).map((j) => fromJob(j, fleet ? 'flota' : 'propio')),
  ], [board, jobs, fleet]);
  const trip = trips.find((t) => t.key === selected) ?? trips[0] ?? null;
  const done = jobs.filter((j) => !ACTIVE_JOB.includes(j.status));

  const offers = useMemo<AnyOffer[]>(() => {
    if (!onDuty) return [];
    const all: AnyOffer[] = [
      ...fleetOffers.map((o) => ({ kind: 'flota' as const, offer: o })),
      ...(board?.available ?? []).map((o) => ({ kind: 'nayo' as const, offer: o })),
    ];
    return all.filter((o) => !skipped.includes(offerKey(o)));
  }, [onDuty, fleetOffers, board, skipped]);
  const offer = offers[0] ?? null;

  // Suena y vibra cuando aparece un pedido que no habia visto.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = offers.filter((o) => !seen.current.has(offerKey(o)));
    fresh.forEach((o) => seen.current.add(offerKey(o)));
    if (fresh.length) {
      ding();
      if (trips.length) setOffersOpen(false);
    }
  }, [offers, trips.length]);

  const accept = (o: AnyOffer) => act(`offer:${offerKey(o)}`, () => (o.kind === 'nayo'
    ? fleetApi(`/fleet/marketplace/orders/${o.offer.id}/take`, { method: 'POST' })
    : fleetApi(`/fleet/offers/${o.offer.id}/accept`, { method: 'POST' })))
    .then((ok) => { if (ok) { setOffersOpen(false); setCollapsed(false); setFit((n) => n + 1); } });
  const skip = (o: AnyOffer) => {
    if (o.kind === 'flota') void act(`decline:${o.offer.id}`, () => fleetApi(`/fleet/offers/${o.offer.id}/decline`, { method: 'POST' }));
    else setSkipped((s) => [...s, offerKey(o)]);
  };

  const advance = (t: Trip) => {
    if (t.source === 'nayo') {
      void act(`trip:${t.key}`, () => fleetApi(`/fleet/marketplace/orders/${t.id}/${t.stage === 'recoger' ? 'pickup' : 'deliver'}`, { method: 'POST' }))
        .then(() => setFit((n) => n + 1));
    } else if (t.job && t.next) {
      if (t.next.status === 'entregado') setFinishing({ job: t.job, mode: 'entregado' });
      else void setStatus(t.job, t.next.status).then(() => setFit((n) => n + 1));
    }
  };
  const secondary = (t: Trip): (() => void) | null => {
    if (t.source === 'nayo') {
      return t.stage === 'recoger'
        ? () => { if (window.confirm('¿Soltar este pedido? Se le ofrecerá a otro repartidor.')) void act(`release:${t.id}`, () => fleetApi(`/fleet/marketplace/orders/${t.id}/release`, { method: 'POST' })); }
        : null;
    }
    return t.job && ['recogido', 'en_camino'].includes(t.status) ? () => setFinishing({ job: t.job!, mode: 'fallido' }) : null;
  };

  // Mapa: yo, mi zona, la ruta del pedido en curso o los restaurantes con pedidos.
  const me = geo.position ? { latitude: geo.position.latitude, longitude: geo.position.longitude } : null;
  const pins = useMemo<Pin[]>(() => {
    const list: Pin[] = [];
    if (me) list.push({ id: 'me', kind: 'me', point: me });
    if (trip) {
      if (trip.stage === 'recoger' && trip.pickup.point) list.push({ id: `p:${trip.key}`, kind: 'pickup', point: trip.pickup.point });
      if (trip.dropoff.point) list.push({ id: `d:${trip.key}`, kind: 'dropoff', point: trip.dropoff.point });
    } else {
      offers.forEach((o) => { if (o.kind === 'nayo' && o.offer.pickup) list.push({ id: offerKey(o), kind: 'offer', point: o.offer.pickup }); });
    }
    return list;
    // me cambia de objeto en cada lectura; se compara por coordenadas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.latitude, me?.longitude, trip, offers]);
  const route = useMemo(() => pins.filter((p) => p.kind !== 'offer').map((p) => p.point), [pins]);
  const zone = useMemo(() => (fleetMe?.base && fleetMe.radius_km ? { center: fleetMe.base, radius_km: fleetMe.radius_km } : null), [fleetMe]);

  const todayTotal = Number(board?.today.earned ?? 0) + fleetToday;
  const debt = board && board.balance < 0 ? -board.balance : 0;
  const showGo = loaded && !onDuty && approved && !needsZone && !trips.length;
  const showOffer = offer && (!trips.length || offersOpen);

  if (view === 'earnings') return <Earnings board={board} cashPending={cash} fleetToday={fleetToday} onClose={() => setView('home')} />;
  if (view === 'history') return <TodayHistory board={board} done={done} onClose={() => setView('home')} />;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#1d1b19] text-gray-100">
      <div className="absolute inset-0 z-0">
        <DriverMap pins={pins} zone={zone} route={route} fit={fit} padBottom={trip ? 540 : 260} />
      </div>

      {fleet && <PushFab target={{ realm: 'nayo', app: 'repartidor' }} text="Activa avisos de viajes" className="left-1/2 top-[calc(max(0.75rem,env(safe-area-inset-top))+4rem)] -translate-x-1/2 whitespace-nowrap" />}

      {/* Barra de arriba: menu, ganancias y centrar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[600] mx-auto flex max-w-lg items-start justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" onClick={() => setMenu(true)} aria-label="Menú"
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#1A1714] text-white shadow-xl ring-1 ring-white/10">
          <Menu className="h-6 w-6" />
        </button>
        {fleet ? (
          <button type="button" onClick={() => setView('earnings')}
            className="pointer-events-auto flex flex-col items-center rounded-full bg-[#1A1714] px-5 py-1.5 shadow-xl ring-1 ring-white/10">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Hoy</span>
            <span className="text-xl font-black leading-tight text-white">{formatMXN(todayTotal)}</span>
          </button>
        ) : (
          <div className="pointer-events-auto rounded-full bg-[#1A1714] px-4 py-2 text-sm font-semibold text-white shadow-xl ring-1 ring-white/10">
            {cash > 0 ? <span className="text-amber-300">Efectivo {formatMXN(cash)}</span> : restaurant || 'Repartidor'}
          </div>
        )}
        <div className="pointer-events-auto flex flex-col gap-2">
          <button type="button" onClick={() => setFit((n) => n + 1)} aria-label="Centrar mapa"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-[#1A1714] text-white shadow-xl ring-1 ring-white/10">
            <LocateFixed className="h-5 w-5" />
          </button>
          {(fleet || push) && (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#1A1714] shadow-xl ring-1 ring-white/10">
              <PushBell target={fleet ? { realm: 'nayo', app: 'repartidor' } : { realm: 'restaurant' }} className="[&_svg]:h-5 [&_svg]:w-5" />
            </div>
          )}
        </div>
      </div>

      {/* Abajo: Conectarse, pedido nuevo y la hoja con el estado o el pedido en curso */}
      <div className="absolute inset-x-0 bottom-0 z-[700] mx-auto flex max-h-[100dvh] max-w-lg flex-col justify-end gap-3 px-3 pt-24">
        {(error || (onDuty && geo.error) || back === 'ok') && (
          <div className="space-y-2">
            {error && <Alert>{error}</Alert>}
            {onDuty && geo.error && <Alert kind="warning">{geo.error}</Alert>}
            {back === 'ok' && <Alert kind="success">Recibimos tu pago. Tu saldo se actualiza en cuanto se confirma.</Alert>}
          </div>
        )}

        {showGo && (
          <button type="button" onClick={() => void toggleDuty(true)} disabled={busy === 'duty'}
            className="mx-auto flex h-24 w-24 flex-col items-center justify-center rounded-full bg-brand text-brand-contrast shadow-[0_0_0_8px_rgba(255,194,26,0.25)] transition active:scale-95 disabled:opacity-60">
            <Power className="h-7 w-7" />
            <span className="text-sm font-black">Conectarse</span>
          </button>
        )}

        {showOffer && (
          <OfferCard item={offer} index={0} count={offers.length} busy={busy === `offer:${offerKey(offer)}`}
            onAccept={() => void accept(offer)} onSkip={() => skip(offer)} />
        )}

        {!showOffer && (
          <section className="overflow-y-auto rounded-t-3xl bg-[#1A1714] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-10px_40px_rgba(0,0,0,0.5)] ring-1 ring-white/10">
            <button type="button" onClick={() => setCollapsed((c) => !c)} className="flex w-full justify-center pb-2 pt-3" aria-label={collapsed ? 'Mostrar' : 'Ocultar'}>
              <span className="h-1.5 w-10 rounded-full bg-gray-600" />
            </button>

            <div className="flex items-center justify-between gap-3 pb-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-lg font-bold text-white">
                  <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${!approved ? 'bg-amber-400' : onDuty ? 'animate-pulse bg-emerald-400' : 'bg-gray-500'}`} />
                  {!approved ? 'Cuenta en revisión' : trips.length ? (onDuty ? 'Conectado' : 'Desconectado') : onDuty ? 'Buscando pedidos' : 'Estás desconectado'}
                </p>
                {!trips.length && approved && !needsZone && (
                  <p className="text-sm text-gray-400">
                    {onDuty
                      ? (zone ? `Zona de ${zone.radius_km} km · te avisamos con sonido` : 'Te avisamos con sonido')
                      : 'Conéctate para recibir pedidos.'}
                  </p>
                )}
              </div>
              {approved && (onDuty || trips.length > 0) && (
                <button type="button" onClick={() => void toggleDuty(!onDuty)} disabled={busy === 'duty'}
                  className={`flex-shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${onDuty ? 'bg-gray-800 text-gray-200' : 'bg-brand text-brand-contrast'}`}>
                  {onDuty ? 'Desconectar' : 'Conectar'}
                </button>
              )}
              {collapsed && <ChevronUp className="h-5 w-5 flex-shrink-0 text-gray-500" />}
            </div>
            {onDuty && approved && !trips.length && <div className="mb-3 h-1 overflow-hidden rounded-full bg-gray-800"><div className="h-full w-1/3 animate-[nayoscan_1.6s_ease-in-out_infinite] rounded-full bg-brand" /></div>}

            {!collapsed && (
              <div className="max-h-[62dvh] space-y-4 overflow-y-auto pb-1">
                {fleet && fleetMe && !approved && <ReviewNotice me={fleetMe} />}

                {approved && needsZone && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-300">Elige tu epicentro y cuántos kilómetros a la redonda quieres cubrir para ver los pedidos de tu zona.</p>
                    <Button className="w-full py-3" onClick={() => setView('zone')}><MapPin className="h-4 w-4" /> Elegir mi zona</Button>
                  </div>
                )}

                {board?.cash_blocked && (
                  <button type="button" onClick={() => setView('earnings')} className="w-full rounded-2xl bg-red-500/10 px-4 py-3 text-left text-sm text-red-200 ring-1 ring-red-500/30">
                    Debes {formatMXN(debt)} y llegaste al tope: solo te llegan pedidos con tarjeta. <b>Pagar</b>
                  </button>
                )}

                {offer && trips.length > 0 && !offersOpen && (
                  <button type="button" onClick={() => setOffersOpen(true)}
                    className="flex w-full items-center justify-between rounded-2xl bg-brand/15 px-4 py-3 text-left text-sm font-semibold text-brand ring-1 ring-brand/40">
                    {offers.length === 1 ? 'Hay un pedido más en tu zona' : `Hay ${offers.length} pedidos más en tu zona`} <span>Ver</span>
                  </button>
                )}

                {trips.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto">
                    {trips.map((t) => (
                      <button key={t.key} type="button" onClick={() => { setSelected(t.key); setFit((n) => n + 1); }}
                        className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold ${t.key === trip?.key ? 'bg-white text-gray-900' : 'bg-gray-800 text-gray-300'}`}>
                        #{t.folio} · {t.stage === 'recoger' ? 'Recoger' : 'Entregar'}
                      </button>
                    ))}
                  </div>
                )}

                {trip && (
                  <TripCard key={trip.key} trip={trip} busy={busy === `trip:${trip.key}` || busy.startsWith(`${trip.id}:`)}
                    onAdvance={() => advance(trip)} onSecondary={secondary(trip)} />
                )}

                {!trip && approved && !needsZone && fleet && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <button type="button" onClick={() => setView('earnings')} className="rounded-2xl bg-gray-800/70 p-3 text-left">
                      <span className="flex items-center gap-1.5 text-xs text-gray-400"><Wallet className="h-3.5 w-3.5" /> Saldo con Nayo</span>
                      <span className={`mt-0.5 block text-lg font-bold ${debt > 0 ? 'text-amber-300' : (board?.balance ?? 0) > 0 ? 'text-emerald-300' : 'text-white'}`}>
                        {debt > 0 ? `−${formatMXN(debt)}` : formatMXN(board?.balance ?? 0)}
                      </span>
                    </button>
                    <button type="button" onClick={() => setView('history')} className="rounded-2xl bg-gray-800/70 p-3 text-left">
                      <span className="flex items-center gap-1.5 text-xs text-gray-400"><History className="h-3.5 w-3.5" /> Entregas hoy</span>
                      <span className="mt-0.5 block text-lg font-bold text-white">{(board?.today.deliveries ?? 0) + done.filter((j) => j.status === 'entregado').length}</span>
                    </button>
                  </div>
                )}
                {!trip && <div className="flex justify-center"><InstallApp label="Instalar la app" /></div>}
                {!trip && !fleet && cash > 0 && (
                  <p className="rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200 ring-1 ring-amber-500/30">Traes {formatMXN(cash)} en efectivo por entregar en caja.</p>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {menu && (
        <Drawer name={name} nayo={fleet} subtitle={fleet ? 'Repartidor Nayo' : `Repartidor${restaurant ? ` de ${restaurant}` : ''}`}
          onClose={() => setMenu(false)} onLogout={onLogout}
          items={[
            ...(fleet ? [{ icon: <Wallet className="h-5 w-5" />, label: 'Ganancias', hint: `Hoy ${formatMXN(todayTotal)}`, onClick: () => setView('earnings') }] : []),
            { icon: <History className="h-5 w-5" />, label: 'Entregas de hoy', onClick: () => setView('history') },
            ...(fleet && fleetMe && (fleetMe.self_registered || fleetMe.base)
              ? [{ icon: <MapPin className="h-5 w-5" />, label: 'Mi zona', hint: fleetMe.base ? `${fleetMe.radius_km} km a la redonda` : 'Sin elegir', onClick: () => setView('zone') }]
              : []),
          ]} />
      )}
      {finishing && (
        <FinishSheet job={finishing.job} mode={finishing.mode} fleet={fleet} onClose={() => setFinishing(null)}
          onConfirm={async (extra) => {
            const ok = await setStatus(finishing.job, finishing.mode, extra);
            if (ok) setFinishing(null);
          }} />
      )}
      {view === 'zone' && fleetMe && (
        <ZoneModal me={fleetMe} onClose={() => setView('home')} onSaved={(d) => { setFleetMe(d); setView('home'); setFit((n) => n + 1); void load(); }} />
      )}
    </div>
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

// ---------------------------------------------------------------------------
// Nayo: estado del registro y zona de reparto
// ---------------------------------------------------------------------------

function ReviewNotice({ me }: { me: FleetMe }) {
  const pending = me.status === 'pendiente';
  return (
    <div className={`rounded-2xl px-4 py-3 text-sm ring-1 ${pending ? 'bg-amber-500/10 text-amber-200 ring-amber-500/30' : 'bg-red-500/10 text-red-200 ring-red-500/30'}`}>
      <p className="font-semibold">{DRIVER_STATUS_LABEL[me.status]}</p>
      <p className="mt-1">
        {pending
          ? 'Nayo está revisando tu registro. Cuando te aprueben podrás conectarte y recibir pedidos de tu zona.'
          : me.review_note || 'Tu cuenta no puede recibir pedidos. Comunícate con Nayo.'}
      </p>
    </div>
  );
}

function ZoneModal({ me, onClose, onSaved }: { me: FleetMe; onClose: () => void; onSaved: (d: FleetMe) => void }) {
  const [base, setBase] = useState<Point | null>(me.base);
  const [radius, setRadius] = useState(me.radius_km ?? 5);
  const [max, setMax] = useState(15);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<MarketplaceInfo>('/marketplace/info', { noRedirect: true }).then((i) => setMax(i.driver_max_radius_km)).catch(() => {});
  }, []);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fleetApi<{ driver: FleetMe }>('/fleet/zone', { method: 'PUT', body: { base, radius_km: radius } });
      onSaved(r.driver);
    } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  };
  return (
    <Modal title="Mi zona de reparto" onClose={onClose}>
      <div className="space-y-4">
        <ZoneFields base={base} radius={radius} maxRadius={max} onBase={setBase} onRadius={setRadius} />
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void save()} loading={busy} disabled={!base}>Guardar zona</Button>
        </div>
      </div>
    </Modal>
  );
}
