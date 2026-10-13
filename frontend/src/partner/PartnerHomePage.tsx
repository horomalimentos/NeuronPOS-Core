import { ArrowDownRight, ArrowUpRight, ChevronRight, Store } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import type { Listing } from '../marketplace/lib';
import { useAdmin } from '../restaurant/context';

interface Totals {
  orders: number; delivered: number; lost: number; sales: number; avg_ticket: number;
  acceptance_pct: number | null; accept_minutes: number | null; prep_minutes: number | null; online_hours: number;
}
interface Stats {
  days: number; from: string | null; to: string | null; current: Totals; previous: Totals; scheduled_hours: number;
  daily: { day: string; orders: number; sales: number; online_hours: number; scheduled_hours: number }[];
  hourly: { hour: number; orders: number }[];
  top_products: { name: string; quantity: number; total: number }[];
}

const PERIODS = [{ days: 1, label: 'Hoy' }, { days: 7, label: '7 días' }, { days: 30, label: '30 días' }];
const WEEKDAY = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function store(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* almacenamiento bloqueado */ }
  return null;
}

const dayLabel = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  return days <= 7 ? WEEKDAY[d.getDay()] : String(d.getDate());
};
const hoursText = (h: number) => {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return mins ? `${whole} h ${mins} min` : `${whole} h`;
};

/**
 * Inicio de Nayo Partner: como va el restaurante en Nayo. Ventas, pedidos,
 * ticket promedio, horas conectado y tiempos, comparados con el periodo
 * anterior, y graficas por dia y por hora.
 */
export default function PartnerHomePage() {
  const { me } = useAdmin();
  const [days, setDays] = useState(() => Number(store('npp_days')) || 7);
  const [branch, setBranch] = useState(() => store('npp_branch') || '');
  const [stats, setStats] = useState<Stats | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ listings: Listing[] }>('/marketplace/listings').then((r) => setListings(r.listings)).catch(() => {});
  }, []);
  useEffect(() => {
    setStats(null);
    const q = new URLSearchParams({ days: String(days) });
    if (branch) q.set('branch_id', branch);
    api<Stats>(`/marketplace/stats?${q}`).then((s) => { setStats(s); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, [days, branch]);

  const pick = (d: number) => { setDays(d); store('npp_days', String(d)); };
  const pickBranch = (b: string) => { setBranch(b); store('npp_branch', b); };
  const shown = listings.filter((l) => !branch || l.branch_id === branch);
  const c = stats?.current;
  const p = stats?.previous;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-white">Hola, {me.user.name.split(' ')[0]}</h1>
        <div className="flex flex-wrap gap-2">
          {listings.length > 1 && (
            <select className="input w-auto py-1.5 text-sm" value={branch} onChange={(e) => pickBranch(e.target.value)} aria-label="Sucursal">
              <option value="">Todas las sucursales</option>
              {listings.map((l) => <option key={l.branch_id} value={l.branch_id}>{l.branch_name}</option>)}
            </select>
          )}
          <div className="flex rounded-full bg-gray-900 p-1" role="tablist" aria-label="Periodo">
            {PERIODS.map((x) => (
              <button key={x.days} type="button" role="tab" aria-selected={days === x.days} onClick={() => pick(x.days)}
                className={`rounded-full px-3 py-1 text-sm font-medium ${days === x.days ? 'bg-brand text-brand-contrast' : 'text-gray-400 hover:text-white'}`}>
                {x.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {shown.map((l) => <ListingStatus key={l.branch_id} listing={l} />)}
      {error && <Alert>{error}</Alert>}
      {!stats || !c || !p ? (!error && <Spinner />) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Tile label="Ventas" value={formatMXN(c.sales)} now={c.sales} before={p.sales} days={days} big />
            <Tile label="Pedidos entregados" value={String(c.delivered)} now={c.delivered} before={p.delivered} days={days}
              sub={c.lost ? `${c.lost} rechazado${c.lost > 1 ? 's' : ''} o cancelado${c.lost > 1 ? 's' : ''}` : undefined} />
            <Tile label="Ticket promedio" value={formatMXN(c.avg_ticket)} now={c.avg_ticket} before={p.avg_ticket} days={days} />
            <Tile label="Horas conectado" value={hoursText(c.online_hours)} now={c.online_hours} before={p.online_hours} days={days}
              sub={stats.scheduled_hours ? `de ${hoursText(stats.scheduled_hours)} de horario` : 'Sin horario en Nayo'} />
            <Tile label="Pedidos aceptados" value={c.acceptance_pct === null ? '—' : `${c.acceptance_pct} %`}
              sub={c.accept_minutes === null ? undefined : `Aceptas en ${c.accept_minutes.toFixed(1)} min en promedio`} />
            <Tile label="Preparación" value={c.prep_minutes === null ? '—' : `${Math.round(c.prep_minutes)} min`}
              sub="De aceptado a listo para recoger" />
          </div>

          {days > 1 && (
            <ChartCard title="Ventas por día" note={`Total ${formatMXN(c.sales)}`}>
              <Bars data={stats.daily.map((d) => ({
                key: d.day, label: dayLabel(d.day, days), value: d.sales,
                tip: `${new Date(`${d.day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' })}: ${formatMXN(d.sales)} · ${d.orders} pedido${d.orders === 1 ? '' : 's'}`,
              }))} every={days > 7 ? 5 : 1} />
            </ChartCard>
          )}

          {days > 1 && (
            <ChartCard title="Horas conectado por día" note="La barra gris es tu horario; la amarilla, lo que estuviste conectado.">
              <Bars data={stats.daily.map((d) => ({
                key: d.day, label: dayLabel(d.day, days), value: d.online_hours, track: d.scheduled_hours,
                tip: `${new Date(`${d.day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' })}: ${hoursText(d.online_hours)} de ${hoursText(d.scheduled_hours)}`,
              }))} every={days > 7 ? 5 : 1} />
            </ChartCard>
          )}

          <ChartCard title="Pedidos por hora" note="A qué horas te piden más">
            <Bars data={stats.hourly.map((h) => ({
              key: String(h.hour), label: String(h.hour), value: h.orders,
              tip: `${h.hour}:00 a ${h.hour}:59 · ${h.orders} pedido${h.orders === 1 ? '' : 's'}`,
            }))} every={3} />
          </ChartCard>

          <ChartCard title="Lo más vendido">
            {stats.top_products.length === 0 ? <p className="py-4 text-center text-sm text-gray-500">Aún sin pedidos entregados en este periodo.</p> : (
              <ul className="space-y-2.5">
                {stats.top_products.map((t) => (
                  <li key={t.name}>
                    <div className="mb-1 flex justify-between gap-3 text-sm">
                      <span className="truncate text-white">{t.name}</span>
                      <span className="shrink-0 text-gray-400">{t.quantity} · {formatMXN(t.total)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-800">
                      <div className="h-2 rounded-full bg-brand" style={{ width: `${(t.quantity / stats.top_products[0].quantity) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}

/** Estado de la ficha: si los clientes te ven ahora o por que no. */
function ListingStatus({ listing: l }: { listing: Listing }) {
  const paused = Boolean(l.paused_until);
  const ok = l.visible;
  const text = ok ? 'Visible para los clientes'
    : l.approval_status === 'pendiente' ? 'NeuronPOS está revisando tu registro'
      : l.blocked || l.approval_status === 'rechazado' ? 'No visible: comunícate con NeuronPOS'
        : !l.published ? 'Sin publicar' : paused ? 'En pausa' : 'Te falta completar tu ficha';
  return (
    <Link to="/partner/ajustes" className={`card flex items-center gap-3 px-4 py-3 ${ok ? '' : 'border-amber-700/60'}`}>
      <Store className={`h-5 w-5 shrink-0 ${ok ? 'text-emerald-400' : 'text-amber-300'}`} />
      <div className="mr-auto min-w-0">
        <p className="truncate text-sm font-medium text-white">{l.branch_name}</p>
        <p className={`text-xs ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>{text}</p>
      </div>
      <ChevronRight className="h-5 w-5 text-gray-500" />
    </Link>
  );
}

function Tile({ label, value, sub, now, before, days, big }: {
  label: string; value: string; sub?: string; now?: number; before?: number; days?: number; big?: boolean;
}) {
  const compare = now !== undefined && before !== undefined && before > 0;
  const change = compare ? Math.round(((now - before) / before) * 100) : 0;
  const prevLabel = days === 1 ? 'vs ayer' : `vs ${days} días antes`;
  return (
    <div className={`card p-4 ${big ? 'col-span-2 lg:col-span-1' : ''}`}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-1 font-semibold tracking-tight text-white ${big ? 'text-3xl' : 'text-2xl'}`}>{value}</p>
      {compare && (
        <p className={`mt-1 flex items-center gap-0.5 text-xs ${change >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
          {change >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          {change >= 0 ? '+' : ''}{change} % <span className="text-gray-500">{prevLabel}</span>
        </p>
      )}
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function ChartCard({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3">
        <h2 className="font-semibold text-white">{title}</h2>
        {note && <p className="text-xs text-gray-400">{note}</p>}
      </div>
      {children}
    </section>
  );
}

type Bar = { key: string; label: string; value: number; track?: number; tip: string };

/**
 * Barras verticales de una sola serie (mostaza). Al pasar el dedo o el
 * cursor sobre una barra se ve su valor arriba de la grafica.
 * track: barra gris de fondo (p. ej. las horas de horario).
 */
function Bars({ data, every = 1 }: { data: Bar[]; every?: number }) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.track || 0)));
  const shown = data.find((d) => d.key === active);
  return (
    <div onMouseLeave={() => setActive(null)}>
      <p className="mb-2 h-4 text-xs text-gray-300" aria-live="polite">{shown?.tip ?? ''}</p>
      <div className="flex h-36 items-end gap-0.5 border-b border-gray-700">
        {data.map((d) => (
          <button key={d.key} type="button" aria-label={d.tip} title={d.tip}
            onMouseEnter={() => setActive(d.key)} onFocus={() => setActive(d.key)} onClick={() => setActive(d.key)}
            className={`relative flex h-full flex-1 items-end justify-center rounded-t ${active === d.key ? 'bg-white/5' : ''}`}>
            {d.track !== undefined && d.track > 0 && (
              <span className="absolute bottom-0 w-full max-w-[28px] rounded-t bg-gray-700/70" style={{ height: `${(d.track / max) * 100}%` }} />
            )}
            <span className="relative w-full max-w-[28px] rounded-t bg-brand" style={{ height: d.value > 0 ? `max(2px, ${(d.value / max) * 100}%)` : 0 }} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5">
        {data.map((d, i) => (
          <span key={d.key} className="flex-1 text-center text-[10px] text-gray-500">{i % every === 0 ? d.label : ''}</span>
        ))}
      </div>
    </div>
  );
}
