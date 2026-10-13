import {
  ArrowLeft, Bike, Check, ChefHat, Clock, CreditCard, Banknote, LogOut, Maximize, MapPin, PackageCheck, PauseCircle,
  Phone, PlayCircle, Printer, Volume2, VolumeX, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import InstallApp from '../components/InstallApp';
import { NayoMark } from '../components/NayoLogo';
import { PushBell, PushFab } from '../components/PushBell';
import { useNayoFavicon } from '../components/useNayoFavicon';
import { Alert, Button, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { closeNotification } from '../lib/pwa';
import { useLive } from '../lib/live';
import { formatTime } from '../pos/lib';
import type { Listing } from './lib';
import { ChatButton } from './OrderChat';
import { ACTIVE, STATUS_LABEL, itemCount, type DeliveryOrder, type DeliveryStatus } from './orders';

const POLL_MS = 8000;
/** Latido de "conectado" para las horas conectado de Nayo Partner. */
const PRESENCE_MS = 60000;
const RING_MS = 3500;
const PREP_CHOICES = [10, 15, 20, 25, 30, 40, 50, 60];
const REJECT_REASONS = ['Se nos agotó un producto', 'La cocina está saturada', 'Estamos por cerrar'];
const SECTIONS: { status: DeliveryStatus; title: string; tone: string }[] = [
  { status: 'nuevo', title: 'Nuevos', tone: 'text-amber-300' },
  { status: 'aceptado', title: 'En preparación', tone: 'text-sky-300' },
  { status: 'listo', title: 'Listos para recoger', tone: 'text-emerald-300' },
  { status: 'en_camino', title: 'En camino', tone: 'text-violet-300' },
];
const STATUS_CHIP: Record<DeliveryStatus, string> = {
  nuevo: 'bg-amber-500 text-gray-950', aceptado: 'bg-sky-500/20 text-sky-200', listo: 'bg-emerald-500/20 text-emerald-200',
  en_camino: 'bg-violet-500/20 text-violet-200', entregado: 'bg-gray-700 text-gray-200',
  rechazado: 'bg-red-500/20 text-red-200', cancelado: 'bg-red-500/20 text-red-200',
};

function store(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* almacenamiento bloqueado */ }
  return null;
}

const minutesBetween = (from: string, to: number) => Math.round((to - new Date(from).getTime()) / 60000);

/**
 * Pantalla de pedidos de Nayo para la tablet del restaurante, al estilo de
 * Uber Eats o DiDi Food: los pedidos se acumulan a la izquierda por estado y
 * el seleccionado se ve a la derecha con sus botones. Suena mientras haya un
 * pedido sin aceptar y se actualiza al instante (canal en vivo + consulta).
 */
export default function NayoOrdersBoard({ exitTo = '/admin/delivery' }: { exitTo?: string } = {}) {
  useNayoFavicon();
  const [orders, setOrders] = useState<DeliveryOrder[] | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState('');
  const [branch, setBranch] = useState(() => store('npd_board_branch') || '');
  const [tab, setTab] = useState<'activos' | 'historial'>('activos');
  const [selected, setSelected] = useState<string | null>(null);
  const [unseen, setUnseen] = useState<Set<string>>(new Set());
  const [sound, setSound] = useState(() => store('npd_board_sound') !== 'off');
  const [audioReady, setAudioReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string> | null>(null);
  const audio = useRef<AudioContext | null>(null);

  const load = useCallback(() => {
    api<{ orders: DeliveryOrder[] }>('/marketplace/orders').then((r) => {
      setOrders(r.orders);
      setError('');
      // Pedidos que aparecieron desde la ultima consulta: se marcan y suenan.
      const ids = new Set(r.orders.filter((o) => ACTIVE.includes(o.status)).map((o) => o.id));
      if (known.current) {
        const fresh = [...ids].filter((id) => !known.current?.has(id));
        if (fresh.length) {
          setUnseen((u) => new Set([...u, ...fresh]));
          ring();
        }
      }
      known.current = new Set([...(known.current || []), ...ids]);
    }).catch((e) => setError(errorMessage(e)));
  }, []);
  const loadListings = useCallback(() => {
    api<{ listings: Listing[] }>('/marketplace/listings').then((r) => setListings(r.listings)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    loadListings();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 20000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [load, loadListings]);

  // ---- Sonido: el navegador solo deja sonar despues de un toque en la pantalla.
  const unlock = () => {
    if (!audio.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      audio.current = new Ctx();
    }
    void audio.current.resume().then(() => setAudioReady(audio.current?.state === 'running'));
  };
  const soundRef = useRef(sound);
  soundRef.current = sound;
  function ring() {
    const ctx = audio.current;
    if (!soundRef.current || !ctx || ctx.state !== 'running') return;
    [0, 0.18, 0.36].forEach((at, k) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = k === 1 ? 1175 : 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.17);
    });
  }

  const visible = useMemo(() => (orders || []).filter((o) => !branch || o.branch_id === branch), [orders, branch]);
  const active = visible.filter((o) => ACTIVE.includes(o.status));
  const history = visible.filter((o) => !ACTIVE.includes(o.status));
  const waiting = active.filter((o) => o.status === 'nuevo').length;

  // Suena sin parar mientras haya pedidos sin aceptar.
  useEffect(() => {
    if (!waiting) return undefined;
    ring();
    const t = setInterval(ring, RING_MS);
    return () => clearInterval(t);
  }, [waiting, sound, audioReady]);

  // Pedido aceptado o rechazado (aqui o en otro dispositivo): se quita su
  // aviso del telefono; el servidor ya no lo repite.
  const ringing = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set((orders || []).filter((o) => o.status === 'nuevo').map((o) => o.id));
    ringing.current.forEach((id) => { if (!now.has(id)) closeNotification(`nayo-${id}`); });
    ringing.current = now;
  }, [orders]);

  useEffect(() => {
    const prev = document.title;
    document.title = waiting ? `(${waiting}) Nuevo pedido · Nayo` : 'Pedidos · Nayo';
    return () => { document.title = prev; };
  }, [waiting]);

  // Mientras la pantalla esta abierta el restaurante cuenta como conectado
  // (si su ficha esta publicada y sin pausa; lo decide el servidor).
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      api('/marketplace/presence', { method: 'POST', body: { branch_id: branch || undefined } }).catch(() => {});
    };
    beat();
    const t = setInterval(beat, PRESENCE_MS);
    document.addEventListener('visibilitychange', beat);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', beat); };
  }, [branch]);

  // Mantiene la pantalla encendida (tablet en el mostrador).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const take = () => {
      if (document.visibilityState === 'visible' && nav.wakeLock) nav.wakeLock.request('screen').then((l) => { lock = l; }).catch(() => {});
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => { document.removeEventListener('visibilitychange', take); void lock?.release().catch(() => {}); };
  }, []);

  // Seleccion: si no hay o ya no esta en la lista, el primer nuevo o el primero activo.
  const list = tab === 'activos' ? active : history;
  const current = list.find((o) => o.id === selected) || null;
  useEffect(() => {
    if (current || !orders) return;
    const first = list.find((o) => o.status === 'nuevo') || list[0];
    if (first && window.matchMedia('(min-width: 768px)').matches) setSelected(first.id);
  }, [current, list, orders]);

  const pick = (id: string) => {
    setSelected(id);
    setUnseen((u) => { const n = new Set(u); n.delete(id); return n; });
  };

  const branches = listings.filter((l) => l.published);
  const branchIds = branch ? [branch] : branches.map((l) => l.branch_id);
  const listing = branch ? listings.find((l) => l.branch_id === branch) : branches.length === 1 ? branches[0] : undefined;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-gray-950 text-gray-100" onPointerDown={unlock}>
      <PushFab target={{ realm: 'nayo', app: 'restaurante' }} text="Activa avisos de pedidos nuevos" className="bottom-6 right-4" />
      {branchIds.map((id) => <LiveBranch key={id} id={id} onChange={load} />)}

      <header className="flex flex-wrap items-center gap-3 border-b border-gray-800 bg-gray-900 px-4 py-2.5">
        <NayoMark className="h-8 w-8" />
        <div className="mr-auto">
          <p className="text-base font-bold leading-tight text-white">Pedidos Nayo</p>
          <p className="text-xs text-gray-400">{waiting ? <span className="font-semibold text-amber-300">{waiting} esperando respuesta</span> : `${active.length} en curso`}</p>
        </div>
        {branches.length > 1 && (
          <select className="input w-auto py-1.5 text-sm" value={branch}
            onChange={(e) => { setBranch(e.target.value); store('npd_board_branch', e.target.value); setSelected(null); }}>
            <option value="">Todas las sucursales</option>
            {branches.map((l) => <option key={l.branch_id} value={l.branch_id}>{l.branch_name}</option>)}
          </select>
        )}
        <InstallApp label="Instalar app" />
        <PushBell target={{ realm: 'nayo', app: 'restaurante' }} label className="[&_svg]:h-4 [&_svg]:w-4" />
        {listing && <PauseControl listing={listing} onChange={(l) => setListings((all) => all.map((x) => (x.branch_id === l.branch_id ? l : x)))} />}
        <button type="button" title={sound ? 'Silenciar' : 'Activar sonido'}
          onClick={() => { const v = !sound; setSound(v); store('npd_board_sound', v ? 'on' : 'off'); }}
          className="rounded-xl border border-gray-700 p-2 text-gray-200 hover:bg-gray-800">
          {sound ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5 text-red-300" />}
        </button>
        {document.fullscreenEnabled && (
          <button type="button" title="Pantalla completa" className="hidden rounded-xl border border-gray-700 p-2 text-gray-200 hover:bg-gray-800 sm:block"
            onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => {}); }}>
            <Maximize className="h-5 w-5" />
          </button>
        )}
        <Link to={exitTo} title="Salir" className="rounded-xl border border-gray-700 p-2 text-gray-200 hover:bg-gray-800">
          <LogOut className="h-5 w-5" />
        </Link>
      </header>

      {sound && !audioReady && (
        <button type="button" onClick={unlock} className="bg-amber-500 px-4 py-2 text-center text-sm font-semibold text-gray-950">
          Toca aquí para activar el sonido de pedidos nuevos
        </button>
      )}
      {error && <div className="px-4 pt-3"><Alert>{error}</Alert></div>}

      <div className="flex min-h-0 flex-1">
        {/* Lista: se acumulan a la izquierda */}
        <aside className={`${current ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-gray-800 bg-gray-900/40 md:w-80 lg:w-96`}>
          <div className="grid grid-cols-2 gap-1 p-2">
            {(['activos', 'historial'] as const).map((t) => (
              <button key={t} type="button" onClick={() => { setTab(t); setSelected(null); }}
                className={`rounded-lg py-2 text-sm font-semibold ${tab === t ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50'}`}>
                {t === 'activos' ? `En curso (${active.length})` : `Hoy (${history.length})`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {orders && list.length === 0 && (
              <p className="px-3 py-10 text-center text-sm text-gray-500">
                {tab === 'activos' ? 'Sin pedidos en curso. Esta pantalla avisa y suena cuando llegue uno.' : 'Aún no hay pedidos terminados hoy.'}
              </p>
            )}
            {tab === 'activos' ? SECTIONS.map((s) => {
              const rows = active.filter((o) => o.status === s.status);
              if (!rows.length) return null;
              return (
                <section key={s.status} className="mt-2">
                  <h3 className={`px-2 pb-1 text-xs font-bold uppercase tracking-wide ${s.tone}`}>{s.title} · {rows.length}</h3>
                  <div className="space-y-1.5">
                    {rows.map((o) => <OrderRow key={o.id} o={o} now={now} active={o.id === current?.id} fresh={unseen.has(o.id)} showBranch={!branch && branches.length > 1} onClick={() => pick(o.id)} />)}
                  </div>
                </section>
              );
            }) : (
              <div className="space-y-1.5">
                {history.map((o) => <OrderRow key={o.id} o={o} now={now} active={o.id === current?.id} fresh={false} showBranch={!branch && branches.length > 1} onClick={() => pick(o.id)} />)}
              </div>
            )}
          </div>
        </aside>

        {/* Detalle del pedido seleccionado */}
        <main className={`${current ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {current ? (
            <OrderDetail key={current.id} o={current} now={now} listings={listings} onBack={() => setSelected(null)} onDone={load} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-gray-500">
              <NayoMark className="h-20 w-20 opacity-40" />
              <p>{orders ? 'Esperando pedidos…' : 'Cargando…'}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function LiveBranch({ id, onChange }: { id: string; onChange: () => void }) {
  useLive(id, onChange);
  return null;
}

function timing(o: DeliveryOrder, now: number): { text: string; late: boolean } {
  if (o.status === 'nuevo') return { text: `hace ${Math.max(0, minutesBetween(o.created_at, now))} min`, late: minutesBetween(o.created_at, now) >= 3 };
  if (o.status === 'aceptado' && o.estimated_ready_at) {
    const left = -minutesBetween(o.estimated_ready_at, now);
    return left >= 0 ? { text: `listo en ${left} min`, late: false } : { text: `${-left} min tarde`, late: true };
  }
  if (o.status === 'listo') return { text: o.driver_assigned ? 'repartidor asignado' : 'buscando repartidor', late: false };
  if (o.status === 'en_camino') return { text: o.picked_up_at ? `salió ${formatTime(o.picked_up_at)}` : 'en camino', late: false };
  return { text: formatTime(o.created_at), late: false };
}

function OrderRow({ o, now, active, fresh, showBranch, onClick }: {
  o: DeliveryOrder; now: number; active: boolean; fresh: boolean; showBranch: boolean; onClick: () => void;
}) {
  const t = timing(o, now);
  const isNew = o.status === 'nuevo';
  return (
    <button type="button" onClick={onClick}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${active ? 'border-brand bg-gray-800' : isNew ? 'animate-pulse border-amber-500 bg-amber-950/40' : 'border-gray-800 bg-gray-900 hover:bg-gray-800/70'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-white">#{o.folio} · {o.customer_name.split(' ')[0]}</span>
        {fresh && !isNew ? <span className="rounded-full bg-amber-500 px-2 text-[10px] font-bold text-gray-950">NUEVO</span>
          : <span className={`shrink-0 text-xs ${t.late ? 'font-semibold text-red-300' : 'text-gray-400'}`}>{t.text}</span>}
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-gray-400">
        <span>{itemCount(o)} artículo{itemCount(o) === 1 ? '' : 's'} · {formatMXN(o.food_total)}{showBranch && ` · ${o.branch_name}`}</span>
        {o.payment_method === 'tarjeta' ? <CreditCard className="h-3.5 w-3.5 text-emerald-300" /> : <Banknote className="h-3.5 w-3.5" />}
      </div>
      {!ACTIVE.includes(o.status) && <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] ${STATUS_CHIP[o.status]}`}>{STATUS_LABEL[o.status]}</span>}
    </button>
  );
}

function OrderDetail({ o, now, listings, onBack, onDone }: {
  o: DeliveryOrder; now: number; listings: Listing[]; onBack: () => void; onDone: () => void;
}) {
  const defaultPrep = listings.find((l) => l.branch_id === o.branch_id)?.prep_minutes ?? 25;
  const [prep, setPrep] = useState(PREP_CHOICES.reduce((a, b) => (Math.abs(b - defaultPrep) < Math.abs(a - defaultPrep) ? b : a)));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const t = timing(o, now);

  const act = async (action: 'accept' | 'reject' | 'ready', body?: Record<string, unknown>) => {
    setBusy(action);
    setError('');
    try {
      await api(`/marketplace/orders/${o.id}/${action}`, { method: 'POST', body });
      setRejecting(false);
      onDone();
    } catch (e) { setError(errorMessage(e)); }
    setBusy('');
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-gray-800 px-4 py-3 md:px-6">
        <button type="button" onClick={onBack} className="rounded-lg p-1 text-gray-300 hover:bg-gray-800 md:hidden" aria-label="Volver"><ArrowLeft className="h-5 w-5" /></button>
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-2xl font-bold text-white">#{o.folio} · {o.customer_name}</h2>
          <p className="text-sm text-gray-400">
            Llegó a las {formatTime(o.created_at)} · {o.branch_name}
            {ACTIVE.includes(o.status) && <span className={t.late ? 'font-semibold text-red-300' : ''}> · {t.text}</span>}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_CHIP[o.status]}`}>{STATUS_LABEL[o.status]}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        {error && <div className="mb-3"><Alert>{error}</Alert></div>}
        <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
          <section>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Pedido · {itemCount(o)} artículo{itemCount(o) === 1 ? '' : 's'}</h3>
            <ul className="divide-y divide-gray-800 rounded-xl border border-gray-800 bg-gray-900">
              {o.items.map((i, k) => (
                <li key={k} className="flex gap-3 px-4 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-800 text-base font-bold text-white">{i.quantity}</span>
                  <div className="min-w-0">
                    <p className="text-lg font-semibold leading-tight text-white">{i.name}</p>
                    {i.modifiers.length > 0 && <p className="text-sm text-gray-400">{i.modifiers.join(', ')}</p>}
                    {i.notes && <p className="text-sm font-medium text-amber-200">“{i.notes}”</p>}
                  </div>
                </li>
              ))}
            </ul>
            {o.notes && <p className="mt-3 rounded-xl border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-amber-100"><b>Nota del cliente:</b> {o.notes}</p>}
            {o.cancel_reason && <p className="mt-3 rounded-xl border border-red-800/50 bg-red-950/30 px-4 py-3 text-red-200">Motivo: {o.cancel_reason}</p>}
          </section>

          <aside className="space-y-3 text-sm">
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <p className="flex items-center justify-between"><span className="text-gray-400">Comida</span><b className="text-lg text-white">{formatMXN(o.food_total)}</b></p>
              <p className="mt-1 flex items-center gap-1.5 text-gray-300">
                {o.payment_method === 'tarjeta'
                  ? <><CreditCard className="h-4 w-4 text-emerald-300" /> El cliente pagó con tarjeta</>
                  : <><Banknote className="h-4 w-4" /> El cliente paga en efectivo</>}
              </p>
              <p className="mt-1 text-xs text-gray-500">El repartidor te paga la comida al recoger.</p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <p className="mb-1 flex items-center gap-1.5 font-semibold text-white"><Bike className="h-4 w-4" /> Repartidor</p>
              {o.driver ? <p className="text-gray-200">{o.driver.name}{o.driver.vehicle && <span className="text-gray-400"> · {o.driver.vehicle}</span>}</p>
                : <p className="text-gray-400">{['nuevo', 'aceptado', 'listo'].includes(o.status) ? 'Buscando repartidor en la zona…' : 'Sin repartidor'}</p>}
              {o.picked_up_at && <p className="text-xs text-gray-400">Recogió a las {formatTime(o.picked_up_at)}</p>}
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-gray-300">
              <p className="flex items-start gap-1.5"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /> {o.address} · {Number(o.distance_km).toFixed(1)} km</p>
              {o.reference && <p className="mt-1 text-xs text-gray-400">{o.reference}</p>}
              <a href={`tel:${o.customer_phone.replace(/[^\d+]/g, '')}`} className="mt-2 inline-flex items-center gap-1.5 text-sky-300"><Phone className="h-4 w-4" /> {o.customer_phone}</a>
            </div>
          </aside>
        </div>
      </div>

      {/* Botones abajo, a la mano en la tablet */}
      <div className="border-t border-gray-800 bg-gray-900 px-4 py-3 md:px-6">
        {o.status === 'nuevo' && (
          <div className="mb-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-sm text-gray-300"><Clock className="h-4 w-4" /> ¿En cuánto tiempo estará listo?</p>
            <div className="flex flex-wrap gap-1.5">
              {PREP_CHOICES.map((m) => (
                <button key={m} type="button" onClick={() => setPrep(m)}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${prep === m ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>{m} min</button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {o.status === 'nuevo' && (
            <>
              <Button className="flex-1 py-4 text-lg" loading={busy === 'accept'} disabled={busy !== ''} onClick={() => void act('accept', { prep_minutes: prep })}>
                <Check className="h-5 w-5" /> Aceptar · listo en {prep} min
              </Button>
              <Button variant="secondary" className="py-4" disabled={busy !== ''} onClick={() => setRejecting(true)}><X className="h-5 w-5" /> Rechazar</Button>
            </>
          )}
          {o.status === 'aceptado' && (
            <Button className="flex-1 py-4 text-lg" loading={busy === 'ready'} disabled={busy !== ''} onClick={() => void act('ready')}>
              <PackageCheck className="h-5 w-5" /> Marcar listo para recoger
            </Button>
          )}
          {/* Pagado con tarjeta: entra aceptado solo; si no se puede surtir, se rechaza y se reembolsa. */}
          {o.status === 'aceptado' && o.payment_method === 'tarjeta' && (
            <Button variant="secondary" className="py-4" disabled={busy !== ''} onClick={() => setRejecting(true)}><X className="h-5 w-5" /> No puedo surtirlo</Button>
          )}
          {o.status === 'listo' && (
            <p className="flex flex-1 items-center gap-2 py-2 text-emerald-300"><ChefHat className="h-5 w-5" />
              {o.driver ? `Listo. ${o.driver.name} va por el pedido.` : 'Listo. Esperando a que un repartidor lo tome.'}</p>
          )}
          {o.status === 'en_camino' && <p className="flex flex-1 items-center gap-2 py-2 text-violet-300"><Bike className="h-5 w-5" /> El pedido va en camino al cliente.</p>}
          {!ACTIVE.includes(o.status) && <span className="flex-1" />}
          <ChatButton chatKey={`r:${o.id}`} count={o.messages} title={`Chat del pedido #${o.folio}`} me="restaurante"
            path={`/marketplace/orders/${o.id}/messages`} call={api} className="py-3 text-sm" />
          <button type="button" onClick={() => printTicket(o)} title="Imprimir comanda"
            className="inline-flex items-center gap-1.5 rounded-xl border border-gray-700 px-3 py-3 text-sm text-gray-200 hover:bg-gray-800">
            <Printer className="h-4 w-4" /> Imprimir
          </button>
        </div>
      </div>

      {rejecting && (
        <RejectModal folio={o.folio} paid={o.payment_method === 'tarjeta'} busy={busy === 'reject'}
          onClose={() => setRejecting(false)} onReject={(reason) => void act('reject', { reason })} />
      )}
    </>
  );
}

function RejectModal({ folio, paid, busy, onClose, onReject }: {
  folio: number; paid: boolean; busy: boolean; onClose: () => void; onReject: (reason: string) => void;
}) {
  const [other, setOther] = useState('');
  return (
    <Modal title={`¿Por qué no puedes surtir el pedido #${folio}?`} onClose={onClose}>
      <p className="mb-3 text-sm text-gray-400">El cliente ve el motivo.{paid && ' Pagó con tarjeta: se le reembolsa.'}</p>
      <div className="space-y-2">
        {REJECT_REASONS.map((r) => (
          <Button key={r} variant="secondary" className="w-full justify-start py-3" disabled={busy} onClick={() => onReject(r)}>{r}</Button>
        ))}
      </div>
      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (other.trim()) onReject(other.trim()); }}>
        <input className="input flex-1" placeholder="Otro motivo" maxLength={300} value={other} onChange={(e) => setOther(e.target.value)} />
        <Button type="submit" variant="danger" loading={busy} disabled={!other.trim()}>Rechazar</Button>
      </form>
    </Modal>
  );
}

function PauseControl({ listing, onChange }: { listing: Listing; onChange: (l: Listing) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const paused = listing.paused_until && new Date(listing.paused_until).getTime() > Date.now();
  const pause = async (minutes: number) => {
    setBusy(true);
    try {
      const r = await api<{ listing: Listing }>(`/marketplace/listings/${listing.branch_id}/pause`, { method: 'POST', body: { minutes } });
      onChange(r.listing);
      setOpen(false);
    } catch { /* se queda como estaba */ }
    setBusy(false);
  };
  if (paused) {
    return (
      <button type="button" disabled={busy} onClick={() => void pause(0)}
        className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-gray-950">
        <PlayCircle className="h-4 w-4" /> En pausa hasta {formatTime(listing.paused_until)} · Reanudar
      </button>
    );
  }
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-sm font-semibold text-emerald-200">
        <span className="h-2 w-2 rounded-full bg-emerald-400" /> Recibiendo pedidos
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-xl border border-gray-700 bg-gray-900 p-2 shadow-xl">
          <p className="px-2 pb-1 text-xs text-gray-400">Pausar pedidos nuevos</p>
          {[15, 30, 60, 120].map((m) => (
            <button key={m} type="button" disabled={busy} onClick={() => void pause(m)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-gray-200 hover:bg-gray-800">
              <PauseCircle className="h-4 w-4" /> {m < 60 ? `${m} minutos` : `${m / 60} hora${m > 60 ? 's' : ''}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Comanda para impresora de tickets (58/80 mm) en una ventana aparte. */
function printTicket(o: DeliveryOrder) {
  const w = window.open('', '_blank', 'width=360,height=640');
  if (!w) return;
  const items = o.items.map((i) => `<p><b>${i.quantity} × ${esc(i.name)}</b>${i.modifiers.length ? `<br><small>${esc(i.modifiers.join(', '))}</small>` : ''}${i.notes ? `<br><small>“${esc(i.notes)}”</small>` : ''}</p>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Nayo #${o.folio}</title>
<style>body{font-family:system-ui,sans-serif;width:72mm;margin:0 auto;font-size:13px}h1{font-size:20px;margin:4px 0}p{margin:6px 0}hr{border:0;border-top:1px dashed #000}</style>
</head><body><h1>NAYO #${o.folio}</h1><p>${esc(o.customer_name)} · ${formatTime(o.created_at)}</p><p>${esc(o.branch_name)}</p><hr>${items}
${o.notes ? `<hr><p><b>Nota:</b> ${esc(o.notes)}</p>` : ''}<hr><p>Comida: <b>${formatMXN(o.food_total)}</b> · ${o.payment_method === 'tarjeta' ? 'Pagado con tarjeta' : 'Efectivo'}</p>
<script>window.onload=function(){window.print();setTimeout(function(){window.close()},300)}</script></body></html>`);
  w.document.close();
}
