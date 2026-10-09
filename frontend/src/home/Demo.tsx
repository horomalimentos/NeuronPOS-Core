import { BarChart3, ChefHat, Check, Clock, CreditCard, Globe, Minus, Monitor, Plus, RotateCcw, Smartphone, Trash2, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatMXN } from '../lib/format';

/**
 * Demo interactivo de la pagina principal. Todo vive en memoria del
 * navegador con un menu de ejemplo: no llama a la API ni guarda nada.
 * Muestra el flujo real del sistema: venta en el POS o pedido en linea ->
 * pantalla de cocina -> resumen de ventas.
 */

type Product = { id: string; name: string; price: number; category: string; emoji: string };
type Line = { product: Product; qty: number };
type Source = 'pos' | 'web';
type Order = {
  id: number;
  source: Source;
  label: string;
  lines: Line[];
  total: number;
  method: 'efectivo' | 'tarjeta' | 'al_recibir';
  status: 'nuevo' | 'preparando' | 'listo';
  at: Date;
};

const MENU: Product[] = [
  { id: 'hamb', name: 'Hamburguesa clásica', price: 135, category: 'Platillos', emoji: '🍔' },
  { id: 'taco', name: 'Orden de tacos', price: 95, category: 'Platillos', emoji: '🌮' },
  { id: 'sushi', name: 'Rollo California', price: 145, category: 'Platillos', emoji: '🍣' },
  { id: 'ensa', name: 'Ensalada César', price: 110, category: 'Platillos', emoji: '🥗' },
  { id: 'papas', name: 'Papas a la francesa', price: 55, category: 'Extras', emoji: '🍟' },
  { id: 'aros', name: 'Aros de cebolla', price: 60, category: 'Extras', emoji: '🧅' },
  { id: 'refresco', name: 'Refresco', price: 35, category: 'Bebidas', emoji: '🥤' },
  { id: 'agua', name: 'Agua de horchata', price: 40, category: 'Bebidas', emoji: '🥛' },
  { id: 'cafe', name: 'Café americano', price: 38, category: 'Bebidas', emoji: '☕' },
  { id: 'pay', name: 'Pay de queso', price: 65, category: 'Postres', emoji: '🍰' },
];
const CATEGORIES = [...new Set(MENU.map((p) => p.category))];

const seed = (): Order[] => {
  const at = new Date(Date.now() - 6 * 60000);
  return [{
    id: 101, source: 'web', label: 'Laura · a domicilio', method: 'al_recibir', status: 'preparando', at,
    lines: [{ product: MENU[0], qty: 2 }, { product: MENU[6], qty: 2 }],
    total: 2 * 135 + 2 * 35,
  }];
};

const sum = (lines: Line[]) => lines.reduce((s, l) => s + l.product.price * l.qty, 0);

function addLine(lines: Line[], product: Product, delta: number): Line[] {
  const found = lines.find((l) => l.product.id === product.id);
  if (!found) return delta > 0 ? [...lines, { product, qty: delta }] : lines;
  return lines
    .map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + delta } : l))
    .filter((l) => l.qty > 0);
}

const TABS = [
  { id: 'pos', label: 'Punto de venta', Icon: Monitor },
  { id: 'cocina', label: 'Cocina', Icon: ChefHat },
  { id: 'web', label: 'Pedidos en línea', Icon: Smartphone },
  { id: 'ventas', label: 'Ventas', Icon: BarChart3 },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function Demo() {
  const [tab, setTab] = useState<Tab>('pos');
  const [orders, setOrders] = useState<Order[]>(seed);
  const [nextId, setNextId] = useState(102);
  const [toast, setToast] = useState('');

  const place = (o: Omit<Order, 'id' | 'status' | 'at'>, message: string) => {
    setOrders((prev) => [...prev, { ...o, id: nextId, status: 'nuevo', at: new Date() }]);
    setNextId((n) => n + 1);
    setToast(message.replace('#', `#${nextId}`));
    window.setTimeout(() => setToast(''), 3500);
  };
  const advance = (id: number) => setOrders((prev) => prev.map((o) => (o.id === id
    ? { ...o, status: o.status === 'nuevo' ? 'preparando' : 'listo' }
    : o)));
  const reset = () => { setOrders(seed()); setNextId(102); setTab('pos'); };
  const pending = orders.filter((o) => o.status !== 'listo').length;

  return (
    <div className="overflow-hidden rounded-3xl border border-gray-800 bg-gray-900 shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 border-b border-gray-800 bg-gray-950/60 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-500/70" />
        <span className="h-3 w-3 rounded-full bg-yellow-500/70" />
        <span className="h-3 w-3 rounded-full bg-green-500/70" />
        <span className="ml-3 truncate text-xs text-gray-500">turestaurante.neuronpos.app · demo con datos de ejemplo</span>
        <button type="button" onClick={reset} className="ml-auto inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white">
          <RotateCcw className="h-3.5 w-3.5" /> Reiniciar
        </button>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-gray-800 px-2 pt-2">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex shrink-0 items-center gap-2 rounded-t-xl px-4 py-2.5 text-sm font-medium transition ${
              tab === id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            <Icon className="h-4 w-4" /> {label}
            {id === 'cocina' && pending > 0 && (
              <span className="rounded-full bg-brand px-1.5 text-xs font-bold text-brand-contrast">{pending}</span>
            )}
          </button>
        ))}
      </div>

      <div className="relative min-h-[30rem] bg-gray-800/40">
        {tab === 'pos' && <PosDemo onCharge={(lines, method, table) => place(
          { source: 'pos', label: table, lines, total: sum(lines), method },
          'Venta cobrada. La orden # ya está en la pantalla de cocina.',
        )} />}
        {tab === 'cocina' && <KitchenDemo orders={orders} onAdvance={advance} />}
        {tab === 'web' && <WebDemo onOrder={(lines, name) => place(
          { source: 'web', label: `${name} · a domicilio`, lines, total: sum(lines), method: 'al_recibir' },
          'Pedido en línea # recibido. Revisa la pestaña Cocina.',
        )} />}
        {tab === 'ventas' && <SalesDemo orders={orders} />}

        {toast && (
          <div className="absolute inset-x-0 top-3 z-10 flex justify-center px-4">
            <button type="button" onClick={() => setTab('cocina')} className="flex items-center gap-2 rounded-full bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-lg">
              <Check className="h-4 w-4" /> {toast}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PosDemo({ onCharge }: { onCharge: (lines: Line[], method: 'efectivo' | 'tarjeta', table: string) => void }) {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [lines, setLines] = useState<Line[]>([]);
  const [table, setTable] = useState('Mesa 4');
  const total = sum(lines);

  const charge = (method: 'efectivo' | 'tarjeta') => {
    if (!lines.length) return;
    onCharge(lines, method, table);
    setLines([]);
  };

  return (
    <div className="grid gap-4 p-4 md:grid-cols-[1fr_18rem]">
      <div>
        <div className="mb-3 flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button key={c} type="button" onClick={() => setCategory(c)}
              className={`rounded-full px-3.5 py-1.5 text-sm ${c === category ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
              {c}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MENU.filter((p) => p.category === category).map((p) => (
            <button key={p.id} type="button" onClick={() => setLines((l) => addLine(l, p, 1))}
              className="rounded-2xl border border-gray-700 bg-gray-900 p-3 text-left transition hover:border-brand active:scale-[0.98]">
              <span className="text-3xl">{p.emoji}</span>
              <span className="mt-2 block text-sm font-medium text-white">{p.name}</span>
              <span className="text-sm text-gray-400">{formatMXN(p.price)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col rounded-2xl border border-gray-700 bg-gray-900 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Cuenta</span>
          <select value={table} onChange={(e) => setTable(e.target.value)} className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200">
            {['Mesa 1', 'Mesa 2', 'Mesa 4', 'Barra', 'Para llevar'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {!lines.length && <p className="py-10 text-center text-sm text-gray-500">Toca un producto para agregarlo</p>}
          {lines.map((l) => (
            <div key={l.product.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-gray-200">{l.product.name}</span>
              <button type="button" aria-label="Quitar uno" onClick={() => setLines((x) => addLine(x, l.product, -1))} className="rounded-md bg-gray-800 p-1 text-gray-300"><Minus className="h-3 w-3" /></button>
              <span className="w-5 text-center text-white">{l.qty}</span>
              <button type="button" aria-label="Agregar uno" onClick={() => setLines((x) => addLine(x, l.product, 1))} className="rounded-md bg-gray-800 p-1 text-gray-300"><Plus className="h-3 w-3" /></button>
              <span className="w-16 text-right text-gray-300">{formatMXN(l.product.price * l.qty)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-gray-700 pt-3">
          <div className="mb-3 flex justify-between text-lg font-semibold text-white"><span>Total</span><span>{formatMXN(total)}</span></div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!lines.length} onClick={() => charge('efectivo')}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-green-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
              <Wallet className="h-4 w-4" /> Efectivo
            </button>
            <button type="button" disabled={!lines.length} onClick={() => charge('tarjeta')}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-brand py-2.5 text-sm font-semibold text-brand-contrast disabled:opacity-40">
              <CreditCard className="h-4 w-4" /> Tarjeta
            </button>
          </div>
          {lines.length > 0 && (
            <button type="button" onClick={() => setLines([])} className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-gray-500 hover:text-gray-300">
              <Trash2 className="h-3.5 w-3.5" /> Vaciar cuenta
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const minutesAgo = (d: Date) => Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));

function KitchenDemo({ orders, onAdvance }: { orders: Order[]; onAdvance: (id: number) => void }) {
  const active = orders.filter((o) => o.status !== 'listo');
  if (!active.length) {
    return <p className="px-6 py-24 text-center text-gray-400">No hay órdenes pendientes. Cobra una venta o haz un pedido en línea y aparecerá aquí.</p>;
  }
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {active.map((o) => (
        <div key={o.id} className={`rounded-2xl border-2 bg-gray-900 p-3 ${o.status === 'nuevo' ? 'border-yellow-500' : 'border-blue-500'}`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">#{o.id}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${o.source === 'web' ? 'bg-purple-500/20 text-purple-300' : 'bg-gray-700 text-gray-300'}`}>
              {o.source === 'web' ? 'En línea' : 'POS'}
            </span>
          </div>
          <p className="text-xs text-gray-400">{o.label}</p>
          <p className="mb-2 flex items-center gap-1 text-xs text-gray-500"><Clock className="h-3 w-3" /> hace {minutesAgo(o.at)} min</p>
          <ul className="mb-3 space-y-1 text-sm text-gray-200">
            {o.lines.map((l) => <li key={l.product.id}><span className="font-semibold">{l.qty}×</span> {l.product.name}</li>)}
          </ul>
          <button type="button" onClick={() => onAdvance(o.id)}
            className={`w-full rounded-xl py-2 text-sm font-semibold text-white ${o.status === 'nuevo' ? 'bg-yellow-600' : 'bg-blue-600'}`}>
            {o.status === 'nuevo' ? 'Empezar a preparar' : 'Marcar como listo'}
          </button>
        </div>
      ))}
    </div>
  );
}

function WebDemo({ onOrder }: { onOrder: (lines: Line[], name: string) => void }) {
  const [cart, setCart] = useState<Line[]>([]);
  const [name, setName] = useState('Carlos');
  const total = sum(cart);

  return (
    <div className="flex justify-center p-4">
      <div className="site-light !min-h-0 w-full max-w-sm overflow-hidden rounded-[2rem] border-8 border-gray-950 shadow-xl">
        <div className="bg-brand px-4 py-3 text-brand-contrast">
          <p className="text-xs opacity-80">turestaurante.neuronpos.app</p>
          <p className="font-bold">Tu Restaurante</p>
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto p-3">
          {MENU.slice(0, 7).map((p) => {
            const qty = cart.find((l) => l.product.id === p.id)?.qty || 0;
            return (
              <div key={p.id} className="card-light flex items-center gap-3 p-2.5">
                <span className="text-2xl">{p.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-gray-500">{formatMXN(p.price)}</p>
                </div>
                {qty > 0 && <button type="button" aria-label="Quitar uno" onClick={() => setCart((c) => addLine(c, p, -1))} className="rounded-full bg-gray-100 p-1.5"><Minus className="h-3.5 w-3.5" /></button>}
                {qty > 0 && <span className="w-4 text-center text-sm font-semibold">{qty}</span>}
                <button type="button" aria-label="Agregar" onClick={() => setCart((c) => addLine(c, p, 1))} className="rounded-full bg-brand p-1.5 text-brand-contrast"><Plus className="h-3.5 w-3.5" /></button>
              </div>
            );
          })}
        </div>
        <div className="space-y-2 border-t border-gray-200 bg-white p-3">
          <input className="input-light !py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" aria-label="Tu nombre" />
          <button type="button" disabled={!cart.length || !name.trim()}
            onClick={() => { onOrder(cart, name.trim()); setCart([]); }}
            className="btn-brand w-full">
            <Globe className="h-4 w-4" /> Enviar pedido · {formatMXN(total)}
          </button>
        </div>
      </div>
    </div>
  );
}

function SalesDemo({ orders }: { orders: Order[] }) {
  const stats = useMemo(() => {
    const total = orders.reduce((s, o) => s + o.total, 0);
    const byMethod = { efectivo: 0, tarjeta: 0, al_recibir: 0 };
    const byProduct = new Map<string, number>();
    for (const o of orders) {
      byMethod[o.method] += o.total;
      for (const l of o.lines) byProduct.set(l.product.name, (byProduct.get(l.product.name) || 0) + l.qty);
    }
    const top = [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { total, byMethod, top, count: orders.length, web: orders.filter((o) => o.source === 'web').length };
  }, [orders]);
  const maxTop = stats.top[0]?.[1] || 1;

  return (
    <div className="grid gap-3 p-4 md:grid-cols-2">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Ventas de hoy" value={formatMXN(stats.total)} />
        <Stat label="Órdenes" value={String(stats.count)} />
        <Stat label="Ticket promedio" value={formatMXN(stats.count ? stats.total / stats.count : 0)} />
        <Stat label="Pedidos en línea" value={String(stats.web)} />
      </div>
      <div className="rounded-2xl border border-gray-700 bg-gray-900 p-4">
        <p className="mb-3 text-sm font-semibold text-white">Lo más vendido</p>
        <div className="space-y-2">
          {stats.top.map(([name, qty]) => (
            <div key={name} className="text-sm">
              <div className="flex justify-between text-gray-300"><span>{name}</span><span>{qty}</span></div>
              <div className="mt-1 h-2 rounded-full bg-gray-800"><div className="h-2 rounded-full bg-brand" style={{ width: `${(qty / maxTop) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-gray-700 bg-gray-900 p-4 md:col-span-2">
        <p className="mb-2 text-sm font-semibold text-white">Corte por forma de pago</p>
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Stat label="Efectivo" value={formatMXN(stats.byMethod.efectivo)} small />
          <Stat label="Tarjeta" value={formatMXN(stats.byMethod.tarjeta)} small />
          <Stat label="Pago al recibir" value={formatMXN(stats.byMethod.al_recibir)} small />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className={`rounded-2xl border border-gray-700 bg-gray-900 ${small ? 'p-3' : 'p-4'}`}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`font-semibold text-white ${small ? 'text-base' : 'text-2xl'}`}>{value}</p>
    </div>
  );
}
