import { CloudOff, Minus, Plus, RefreshCw, Search, Trash2, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Button, Modal } from '../components/ui';
import { formatMXN } from '../lib/format';
import {
  nextLocalFolio, offlineMethods, offlineOrder, offlineQueue, offlineTotals, useOfflineQueue, type OfflineCatalog, type OfflineSale,
} from '../lib/offline';
import type { Branch, Restaurant } from '../lib/types';
import ModifierModal, { type CartSelection } from './ModifierModal';
import { formatDateTime, num, round2 } from './lib';
import { comandaHtml, orderTicketHtml, printHtml } from './ticket';
import type { MenuItem } from './types';

interface CartLine extends CartSelection { key: number }
let cartKey = 1;

/**
 * Caja sin internet: venta para llevar con el menu guardado. Cobra en
 * efectivo o tarjeta, imprime ticket y comanda con folio provisional y deja
 * la venta en la cola para subirla cuando vuelva la conexion.
 */
export default function OfflineRegister({ catalog, branch, restaurant, userName, onRetry }: {
  catalog: OfflineCatalog;
  branch: Branch | null;
  restaurant: Restaurant;
  userName: string;
  onRetry: () => void;
}) {
  const { menu, settings } = catalog;
  const methods = offlineMethods(catalog.methods);
  const taxRate = num(branch?.tax_rate_pct ?? settings?.tax_rate_pct ?? 0);
  const pricesIncludeTax = settings?.prices_include_tax ?? true;
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<MenuItem | null>(null);
  const [customer, setCustomer] = useState('');
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState('');

  // Al volver la conexion regresa a la caja normal (si no hay una venta a medias).
  const idle = cart.length === 0 && !paying;
  useEffect(() => {
    if (!idle) return undefined;
    window.addEventListener('online', onRetry);
    return () => window.removeEventListener('online', onRetry);
  }, [idle, onRetry]);

  const groupsById = useMemo(() => new Map(menu.modifier_groups.map((g) => [g.id, g])), [menu]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menu.items.filter((i) => (q ? i.name.toLowerCase().includes(q) : !category || i.category_id === category));
  }, [menu, category, search]);
  const lines = cart.map((l) => ({ unit_price: num(l.item.price), modifiers: l.modifiers.map((m) => ({ price_delta: num(m.price_delta) })), quantity: l.quantity }));
  const totals = offlineTotals(lines, taxRate, pricesIncludeTax);

  function add(sel: CartSelection) {
    setCart((c) => {
      if (!sel.modifiers.length && !sel.notes) {
        const same = c.find((l) => l.item.id === sel.item.id && !l.modifiers.length && !l.notes);
        if (same) return c.map((l) => (l === same ? { ...l, quantity: l.quantity + sel.quantity } : l));
      }
      return [...c, { ...sel, key: cartKey++ }];
    });
    setPick(null);
    setDone('');
  }
  const click = (item: MenuItem) => {
    if (!item.available) return;
    if (item.modifier_group_ids.some((id) => groupsById.get(id))) setPick(item);
    else add({ item, quantity: 1, modifiers: [], notes: '' });
  };
  const qty = (key: number, d: number) => setCart((c) => c.flatMap((l) => {
    if (l.key !== key) return [l];
    const q = l.quantity + d;
    return q > 0 ? [{ ...l, quantity: q }] : [];
  }));

  function charge(methodId: string, received: number | undefined, reference: string) {
    const sale: OfflineSale = {
      offline_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      branch_id: branch?.id || catalog.session?.branch_id || '',
      cash_session_id: catalog.session?.id || null,
      local_folio: nextLocalFolio(),
      customer_name: customer.trim() || null,
      tax_rate_pct: taxRate,
      prices_include_tax: pricesIncludeTax,
      items: cart.map((l) => ({
        menu_item_id: l.item.id, quantity: l.quantity, unit_price: num(l.item.price), notes: l.notes || null,
        modifiers: l.modifiers.map((m) => ({ id: m.id, price_delta: num(m.price_delta) })),
      })),
      payments: [{ payment_method_id: methodId, amount: totals.total, tip: 0, received, reference: reference || null }],
      total: totals.total,
    };
    offlineQueue.add(sale);
    const change = received !== undefined ? round2(received - totals.total) : 0;
    const order = offlineOrder(
      sale,
      new Map(cart.map((l) => [l.item.id, l.item.name])),
      new Map(cart.flatMap((l) => l.modifiers.map((m) => [m.id, { name: m.name, group_name: m.group_name }]))),
      new Map(catalog.methods.map((m) => [m.id, m])),
      totals, userName, change,
    );
    const method = methods.find((m) => m.id === methodId);
    void printHtml(orderTicketHtml(order, restaurant, branch, settings, change), 'ticket', { openDrawer: method?.kind === 'efectivo' });
    void printHtml(comandaHtml(order, order.items!, branch), 'comanda');
    setCart([]);
    setCustomer('');
    setPaying(false);
    setDone(`Venta ${sale.local_folio} guardada${change > 0 ? ` · cambio ${formatMXN(change)}` : ''}. Se sube sola al volver el internet.`);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-100 ring-1 ring-amber-500/30">
        <CloudOff className="h-5 w-5 flex-shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <b>Sin internet.</b> Vendiendo para llevar con el menú guardado ({formatDateTime(catalog.saved_at)}).
          {!catalog.session && ' No había caja abierta: las ventas entrarán a la caja que esté abierta al subirlas.'}
        </div>
        <Button variant="secondary" onClick={onRetry}><RefreshCw className="h-4 w-4" /> Reintentar conexión</Button>
      </div>
      <OfflineQueuePanel />
      {done && <div className="mb-4"><Alert kind="success">{done}</Alert></div>}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0">
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input className="input pl-9" placeholder="Buscar producto" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {[{ id: '', name: 'Todo' }, ...menu.categories].map((c) => (
              <button key={c.id} onClick={() => { setCategory(c.id); setSearch(''); }}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${category === c.id && !search ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((it) => (
              <button key={it.id} onClick={() => click(it)} disabled={!it.available}
                className={`card flex flex-col p-2 text-left transition hover:border-brand/60 ${it.available ? '' : 'cursor-not-allowed opacity-50'}`}>
                <span className="line-clamp-2 text-sm font-medium leading-tight text-white">{it.name}</span>
                <span className="mt-auto pt-1 text-sm text-gray-400">{formatMXN(it.price)}</span>
              </button>
            ))}
          </div>
        </section>

        <aside className="card flex flex-col md:sticky md:top-20 md:max-h-[calc(100vh-6rem)]">
          <div className="border-b border-gray-800 p-4">
            <h2 className="font-semibold text-white">Para llevar · sin internet</h2>
            <input className="input mt-2" placeholder="Nombre del cliente (opcional)" value={customer} maxLength={120} onChange={(e) => setCustomer(e.target.value)} />
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto p-3">
            {cart.length === 0 && <p className="py-8 text-center text-sm text-gray-500">Toca un producto para agregarlo.</p>}
            {cart.map((l) => (
              <div key={l.key} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="text-white">{l.item.name}</span>
                  {l.modifiers.map((m) => <div key={m.id} className="text-xs text-gray-400">+ {m.name}</div>)}
                  {l.notes && <div className="text-xs italic text-amber-200/80">{l.notes}</div>}
                </div>
                <button className="rounded p-1 text-gray-400 hover:bg-gray-800" onClick={() => qty(l.key, -1)} aria-label="Menos">{l.quantity === 1 ? <Trash2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}</button>
                <span className="w-6 text-center font-semibold">{l.quantity}</span>
                <button className="rounded p-1 text-gray-400 hover:bg-gray-800" onClick={() => qty(l.key, 1)} aria-label="Más"><Plus className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
          <div className="space-y-1 border-t border-gray-800 p-4 text-sm">
            <div className="flex justify-between text-gray-400"><span>IVA {taxRate}%{pricesIncludeTax ? ' (incluido)' : ''}</span><span>{formatMXN(totals.tax)}</span></div>
            <div className="flex justify-between text-lg font-semibold text-white"><span>Total</span><span>{formatMXN(totals.total)}</span></div>
            <Button className="mt-2 w-full" disabled={!cart.length || !methods.length} onClick={() => setPaying(true)}>Cobrar {formatMXN(totals.total)}</Button>
            {!methods.length && <p className="text-xs text-amber-300">No hay métodos de pago guardados para usar sin internet.</p>}
          </div>
        </aside>
      </div>
      {pick && (
        <ModifierModal item={pick} groups={pick.modifier_group_ids.map((id) => groupsById.get(id)!).filter(Boolean)}
          onClose={() => setPick(null)} onAdd={add} />
      )}
      {paying && <OfflinePayModal total={totals.total} methods={methods} onClose={() => setPaying(false)} onPay={charge} />}
    </>
  );
}

function OfflinePayModal({ total, methods, onClose, onPay }: {
  total: number;
  methods: ReturnType<typeof offlineMethods>;
  onClose: () => void;
  onPay: (methodId: string, received: number | undefined, reference: string) => void;
}) {
  const [methodId, setMethodId] = useState(methods.find((m) => m.kind === 'efectivo')?.id || methods[0]?.id || '');
  const [received, setReceived] = useState('');
  const [reference, setReference] = useState('');
  const method = methods.find((m) => m.id === methodId);
  const cash = method?.kind === 'efectivo';
  const got = received === '' ? total : Number(received);
  const short = cash && !(got >= total);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (short) return;
    onPay(methodId, cash ? got : undefined, cash ? '' : reference.trim());
  };
  return (
    <Modal title={`Cobrar ${formatMXN(total)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {methods.map((m) => (
            <button key={m.id} type="button" onClick={() => setMethodId(m.id)}
              className={`rounded-xl border px-3 py-3 text-sm font-medium ${m.id === methodId ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-200'}`}>
              {m.name}
            </button>
          ))}
        </div>
        {cash ? (
          <label className="block">
            <span className="label">Recibido</span>
            <input className="input" type="number" inputMode="decimal" min={0} step="0.01" autoFocus placeholder={String(total)}
              value={received} onChange={(e) => setReceived(e.target.value)} />
            {!short && got > total && <span className="mt-1 block text-sm text-emerald-300">Cambio {formatMXN(round2(got - total))}</span>}
            {short && <span className="mt-1 block text-sm text-amber-300">No alcanza para el total</span>}
          </label>
        ) : (
          <label className="block">
            <span className="label">Referencia (opcional)</span>
            <input className="input" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder="Últimos 4 dígitos, autorización…" />
            <span className="mt-1 block text-xs text-gray-400">Cobra en la terminal bancaria por separado; sin internet no se conecta Clip.</span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={short || !methodId}>Cobrar e imprimir</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Ventas sin internet que faltan por subir (en la caja y antes del corte). */
export function OfflineQueuePanel({ canDiscard = false }: { canDiscard?: boolean }) {
  const { sales, sync } = useOfflineQueue(false);
  const [busy, setBusy] = useState(false);
  if (!sales.length) return null;
  const failed = sales.filter((s) => s.error);
  const upload = async () => { setBusy(true); try { await sync(); } finally { setBusy(false); } };
  return (
    <div className="mb-4 rounded-xl bg-gray-900 p-4 text-sm ring-1 ring-amber-500/30">
      <div className="flex flex-wrap items-center gap-3">
        <UploadCloud className="h-5 w-5 text-amber-300" />
        <span className="flex-1 text-gray-200">
          {sales.length === 1 ? '1 venta sin internet' : `${sales.length} ventas sin internet`} por subir
          ({formatMXN(sales.reduce((s, x) => s + x.total, 0))}). Se suben solas al volver la conexión.
        </span>
        <Button variant="secondary" onClick={upload} disabled={busy}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Subir ahora</Button>
      </div>
      {failed.length > 0 && (
        <ul className="mt-3 space-y-1">
          {failed.map((s) => (
            <li key={s.offline_id} className="flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-red-200">
              <span className="flex-1">{s.local_folio} · {formatDateTime(s.created_at)} · {formatMXN(s.total)}: {s.error}</span>
              {canDiscard && (
                <button className="text-xs underline" onClick={() => {
                  if (window.confirm(`¿Descartar la venta ${s.local_folio}? No se va a registrar en el sistema.`)) offlineQueue.remove(s.offline_id);
                }}>Descartar</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
