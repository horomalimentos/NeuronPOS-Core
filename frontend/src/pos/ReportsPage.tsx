import { ArrowDownRight, ArrowUpRight, Download } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { useAdmin } from '../restaurant/context';
import { METHOD_KIND_LABEL, ORDER_TYPE_LABEL } from './lib';
import type { MethodKind, OrderType } from './types';

/**
 * Reportes de ventas: resumen con comparacion contra el periodo anterior,
 * ventas por dia y por hora, metodos de pago, tipos de orden, sucursales,
 * productos, categorias, modificadores y personal. Cada tabla se descarga
 * en CSV (Excel la abre directo).
 */

interface Totals {
  orders: number; subtotal: number; discounts: number; tax: number; delivery_fees: number;
  total: number; tips: number; guests: number; average_ticket: number;
}
export interface Report {
  range: { from: string; to: string; days: number };
  previous_range: { from: string; to: string };
  summary: Totals;
  previous: Totals;
  cancelled: { orders: number; total: number };
  voided: { items: number; total: number };
  by_day: { date: string; orders: number; total: number }[];
  by_hour: { hour: number; orders: number; total: number }[];
  by_weekday: { weekday: number; orders: number; total: number }[];
  by_payment_method: { id: string; name: string; kind: MethodKind; orders: number; amount: number; tips: number }[];
  by_order_type: { order_type: OrderType; source: 'pos' | 'web'; orders: number; total: number }[];
  by_branch: { branch_id: string; branch_name: string; orders: number; total: number; tips: number }[];
  items: { menu_item_id: string; name: string; category: string | null; quantity: number; total: number; orders: number }[];
  categories: { category: string; quantity: number; total: number }[];
  modifiers: { group_name: string; name: string; quantity: number; total: number }[];
  staff: { user_id: string | null; name: string; orders: number; total: number; tips: number; discounts: number }[];
}

const WEEKDAYS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const PRESETS = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'ayer', label: 'Ayer' },
  { key: '7', label: '7 días' },
  { key: '30', label: '30 días' },
  { key: 'mes', label: 'Este mes' },
  { key: 'mes_ant', label: 'Mes pasado' },
] as const;
type Preset = (typeof PRESETS)[number]['key'] | 'custom';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (day: string, n: number) => iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000));

/** Rango de fechas para cada atajo, a partir de "hoy" en la zona de la sucursal. */
function presetRange(key: Preset, today: string): [string, string] {
  const [y, m] = today.split('-').map(Number);
  switch (key) {
    case 'ayer': return [shift(today, -1), shift(today, -1)];
    case '7': return [shift(today, -6), today];
    case '30': return [shift(today, -29), today];
    case 'mes': return [`${today.slice(0, 7)}-01`, today];
    case 'mes_ant': {
      const first = iso(new Date(Date.UTC(m === 1 ? y - 1 : y, (m + 10) % 12, 1)));
      return [first, shift(`${today.slice(0, 7)}-01`, -1)];
    }
    default: return [today, today];
  }
}

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const typeLabel = (t: { order_type: OrderType; source: string }) =>
  `${ORDER_TYPE_LABEL[t.order_type] || t.order_type}${t.source === 'web' ? ' (en línea)' : ''}`;

function downloadCsv(name: string, header: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="text-xs text-gray-500">sin datos del periodo anterior</span>;
  const change = ((now - before) / before) * 100;
  const up = change >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-emerald-300' : 'text-red-300'}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{up ? '+' : ''}{change.toFixed(1)}% <span className="font-normal text-gray-500">vs. anterior</span>
    </span>
  );
}

export function Stat({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</p>
      {extra && <div className="mt-1">{extra}</div>}
    </div>
  );
}

function Section({ title, onCsv, children }: { title: string; onCsv?: () => void; children: ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
        <h2 className="font-semibold text-white">{title}</h2>
        {onCsv && (
          <button type="button" onClick={onCsv} className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Table({ head, rows, empty = 'Sin ventas en este periodo.' }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="px-4 py-6 text-sm text-gray-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
            {head.map((h, i) => <th key={h} className={`px-4 py-2 font-medium ${i ? 'text-right' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/70">
          {rows.map((r, i) => (
            <tr key={i} className="text-gray-200">
              {r.map((c, j) => <td key={j} className={`px-4 py-2 ${j ? 'text-right tabular-nums' : ''}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Barras verticales de una sola serie (ventas), con el valor al pasar el cursor o tocar. */
function Bars({ data, label }: { data: { key: string; label: string; total: number; orders: number }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.total), 0);
  if (!max) return <p className="px-4 py-6 text-sm text-gray-500">Sin ventas en este periodo.</p>;
  const h = hover === null ? null : data[hover];
  return (
    <div className="px-4 pb-4 pt-3">
      <p className="mb-2 h-5 text-sm text-gray-300" aria-live="polite">
        {h ? <><span className="text-gray-400">{h.label}:</span> <b className="text-white">{formatMXN(h.total)}</b> · {h.orders} órdenes</>
          : <span className="text-gray-500">{label}</span>}
      </p>
      <div className="flex h-40 items-end gap-[2px]" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <button
            key={d.key}
            type="button"
            className="group flex h-full min-w-[6px] flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setHover(i)}
            aria-label={`${d.label}: ${formatMXN(d.total)}`}
          >
            <span
              className={`block w-full rounded-t-[4px] transition-colors ${hover === i ? 'bg-brand' : 'bg-brand/60 group-hover:bg-brand'}`}
              style={{ height: `${Math.max((d.total / max) * 100, d.total ? 2 : 0)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-gray-500">
        <span>{data[0].label}</span>
        <span>{data[data.length - 1].label}</span>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const { me } = useAdmin();
  const branches = me.branches;
  const tz = branches[0]?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()), [tz]);
  const [preset, setPreset] = useState<Preset>('hoy');
  const [[from, to], setRange] = useState<[string, string]>(() => presetRange('hoy', today));
  const [branchId, setBranchId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [allItems, setAllItems] = useState(false);

  useEffect(() => {
    if (!from || !to || from > to) return;
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ from, to });
    if (branchId) q.set('branch_id', branchId);
    api<Report>(`/pos/reports/sales?${q}`)
      .then(setReport)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [from, to, branchId]);

  const choose = (key: Preset) => { setPreset(key); setRange(presetRange(key, today)); };
  const file = (name: string) => `${name}_${from}_a_${to}`;

  const daySeries = useMemo(() => {
    if (!report) return [];
    const map = new Map(report.by_day.map((d) => [d.date, d]));
    const out = [];
    for (let d = report.range.from; d <= report.range.to; d = shift(d, 1)) {
      const r = map.get(d);
      out.push({ key: d, label: formatDay(d), total: r?.total || 0, orders: r?.orders || 0 });
    }
    return out;
  }, [report]);
  const hourSeries = useMemo(() => {
    if (!report?.by_hour.length) return [];
    const map = new Map(report.by_hour.map((d) => [d.hour, d]));
    const hours = report.by_hour.map((h) => h.hour);
    const out = [];
    for (let hr = Math.min(...hours); hr <= Math.max(...hours); hr += 1) {
      const r = map.get(hr);
      out.push({ key: String(hr), label: `${String(hr).padStart(2, '0')}:00`, total: r?.total || 0, orders: r?.orders || 0 });
    }
    return out;
  }, [report]);

  const s = report?.summary;
  const items = report ? (allItems ? report.items : report.items.slice(0, 15)) : [];

  return (
    <>
      <PageHeader title="Reportes de ventas" subtitle="Órdenes pagadas, por fecha de cobro." />

      <div className="mb-6 flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl border border-gray-800 bg-gray-900 p-1">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => choose(p.key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${preset === p.key ? 'bg-brand text-brand-contrast' : 'text-gray-300 hover:bg-gray-800'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="text-xs text-gray-500">
          Desde
          <input type="date" className="input mt-1 py-1.5" value={from} max={to}
            onChange={(e) => { setPreset('custom'); setRange([e.target.value, to]); }} />
        </label>
        <label className="text-xs text-gray-500">
          Hasta
          <input type="date" className="input mt-1 py-1.5" value={to} min={from}
            onChange={(e) => { setPreset('custom'); setRange([from, e.target.value]); }} />
        </label>
        {branches.length > 1 && (
          <label className="text-xs text-gray-500">
            Sucursal
            <select className="input mt-1 py-1.5" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Todas</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!report && loading && <Spinner />}

      {report && s && (
        <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ventas" value={formatMXN(s.total)} extra={<Delta now={s.total} before={report.previous.total} />} />
            <Stat label="Órdenes" value={String(s.orders)} extra={<Delta now={s.orders} before={report.previous.orders} />} />
            <Stat label="Ticket promedio" value={formatMXN(s.average_ticket)} extra={<Delta now={s.average_ticket} before={report.previous.average_ticket} />} />
            <Stat label="Propinas" value={formatMXN(s.tips)} extra={<span className="text-xs text-gray-500">aparte de las ventas</span>} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Descuentos" value={formatMXN(s.discounts)} extra={<span className="text-xs text-gray-500">{pct(s.discounts, s.subtotal)} del subtotal</span>} />
            <Stat label="IVA" value={formatMXN(s.tax)} />
            <Stat label="Canceladas" value={String(report.cancelled.orders)} extra={<span className="text-xs text-gray-500">{formatMXN(report.cancelled.total)}</span>} />
            <Stat label="Artículos cancelados" value={String(report.voided.items)} extra={<span className="text-xs text-gray-500">{formatMXN(report.voided.total)} ya enviados a cocina</span>} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {report.range.days > 1 && (
              <Section title="Ventas por día"
                onCsv={() => downloadCsv(file('ventas_por_dia'), ['Fecha', 'Órdenes', 'Ventas'], daySeries.map((d) => [d.key, d.orders, d.total]))}>
                <Bars data={daySeries} label="Toca una barra para ver el día" />
              </Section>
            )}
            <Section title="Ventas por hora"
              onCsv={() => downloadCsv(file('ventas_por_hora'), ['Hora', 'Órdenes', 'Ventas'], hourSeries.map((d) => [d.label, d.orders, d.total]))}>
              <Bars data={hourSeries} label="Toca una barra para ver la hora" />
            </Section>
            {report.range.days >= 7 && (
              <Section title="Ventas por día de la semana"
                onCsv={() => downloadCsv(file('ventas_por_dia_semana'), ['Día', 'Órdenes', 'Ventas'], report.by_weekday.map((d) => [WEEKDAYS[d.weekday], d.orders, d.total]))}>
                <Table head={['Día', 'Órdenes', 'Ventas', '%']}
                  rows={report.by_weekday.map((d) => [WEEKDAYS[d.weekday], d.orders, formatMXN(d.total), pct(d.total, s.total)])} />
              </Section>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Métodos de pago"
              onCsv={() => downloadCsv(file('metodos_de_pago'), ['Método', 'Tipo', 'Órdenes', 'Cobrado', 'Propinas'],
                report.by_payment_method.map((m) => [m.name, METHOD_KIND_LABEL[m.kind] || m.kind, m.orders, m.amount, m.tips]))}>
              <Table head={['Método', 'Órdenes', 'Cobrado', 'Propinas']}
                rows={report.by_payment_method.map((m) => [m.name, m.orders, formatMXN(m.amount), formatMXN(m.tips)])} />
            </Section>
            <Section title="Tipo de orden"
              onCsv={() => downloadCsv(file('tipos_de_orden'), ['Tipo', 'Órdenes', 'Ventas'], report.by_order_type.map((t) => [typeLabel(t), t.orders, t.total]))}>
              <Table head={['Tipo', 'Órdenes', 'Ventas', '%']}
                rows={report.by_order_type.map((t) => [typeLabel(t), t.orders, formatMXN(t.total), pct(t.total, s.total)])} />
            </Section>
          </div>

          <Section title="Productos más vendidos"
            onCsv={() => downloadCsv(file('productos'), ['Producto', 'Categoría', 'Cantidad', 'Órdenes', 'Venta'],
              report.items.map((i) => [i.name, i.category, i.quantity, i.orders, i.total]))}>
            <Table head={['Producto', 'Cantidad', 'Venta', '%']}
              rows={items.map((i) => [
                <span key="n">{i.name}{i.category && <span className="ml-2 text-xs text-gray-500">{i.category}</span>}</span>,
                i.quantity, formatMXN(i.total), pct(i.total, report.items.reduce((a, x) => a + x.total, 0)),
              ])} />
            {report.items.length > 15 && (
              <button type="button" onClick={() => setAllItems(!allItems)} className="w-full border-t border-gray-800 py-2 text-sm text-gray-400 hover:text-white">
                {allItems ? 'Ver menos' : `Ver los ${report.items.length} productos`}
              </button>
            )}
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Categorías"
              onCsv={() => downloadCsv(file('categorias'), ['Categoría', 'Cantidad', 'Venta'], report.categories.map((c) => [c.category, c.quantity, c.total]))}>
              <Table head={['Categoría', 'Cantidad', 'Venta']}
                rows={report.categories.map((c) => [c.category, c.quantity, formatMXN(c.total)])} />
            </Section>
            <Section title="Modificadores"
              onCsv={() => downloadCsv(file('modificadores'), ['Grupo', 'Opción', 'Cantidad', 'Extra cobrado'],
                report.modifiers.map((m) => [m.group_name, m.name, m.quantity, m.total]))}>
              <Table head={['Opción', 'Cantidad', 'Extra cobrado']} empty="No se vendieron modificadores."
                rows={report.modifiers.map((m) => [<span key="n"><span className="text-gray-500">{m.group_name}:</span> {m.name}</span>, m.quantity, formatMXN(m.total)])} />
            </Section>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Por persona (quien abrió la orden)"
              onCsv={() => downloadCsv(file('personal'), ['Persona', 'Órdenes', 'Ventas', 'Propinas', 'Descuentos'],
                report.staff.map((p) => [p.name, p.orders, p.total, p.tips, p.discounts]))}>
              <Table head={['Persona', 'Órdenes', 'Ventas', 'Propinas']}
                rows={report.staff.map((p) => [p.name, p.orders, formatMXN(p.total), formatMXN(p.tips)])} />
            </Section>
            {branches.length > 1 && !branchId && (
              <Section title="Sucursales"
                onCsv={() => downloadCsv(file('sucursales'), ['Sucursal', 'Órdenes', 'Ventas', 'Propinas'],
                  report.by_branch.map((b) => [b.branch_name, b.orders, b.total, b.tips]))}>
                <Table head={['Sucursal', 'Órdenes', 'Ventas', '%']}
                  rows={report.by_branch.map((b) => [b.branch_name, b.orders, formatMXN(b.total), pct(b.total, s.total)])} />
              </Section>
            )}
          </div>
        </div>
      )}
    </>
  );
}
