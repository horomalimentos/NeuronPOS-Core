import {
  ArrowLeft, Ban, ChefHat, ClipboardList, CreditCard, Image as ImageIcon, Minus, Plus, Printer, Save, Search,
  ShoppingBag, Tag, Trash2, Truck, Utensils, Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { useAdmin } from '../restaurant/context';
import BranchSelect from './BranchSelect';
import DiscountModal from './DiscountModal';
import ModifierModal, { type CartSelection } from './ModifierModal';
import PaymentModal from './PaymentModal';
import {
  ORDER_STATUS_LABEL, ORDER_STATUS_STYLE, ORDER_TYPE_LABEL, formatTime, num, posCan, posPrefs, round2,
} from './lib';
import { orderTicketHtml, printHtml } from './ticket';
import type {
  CashSession, DiningTable, Menu, MenuItem, Order, OrderType, PaymentMethod, PosSettings, Zone,
} from './types';
import { usePosBranch } from './usePosBranch';

interface CartLine extends CartSelection { key: number }
interface Draft {
  order_type: OrderType;
  table: DiningTable | null;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  guests: string;
}

let cartKey = 1;
const emptyDraft = (order_type: OrderType, table: DiningTable | null = null): Draft => ({
  order_type, table, customer_name: '', customer_phone: '', customer_address: '', guests: '',
});

/**
 * Pantalla de venta: elegir mesa o tipo de orden, agregar productos con
 * modificadores, enviar a cocina, descuentos y cobro. Inspirada en el
 * POSOrderPage de NeuronPOS (catalogo a la izquierda, cuenta a la derecha).
 */
export default function RegisterPage() {
  const { me } = useAdmin();
  const role = me.user.role;
  const { branchId, setBranchId, branches, branch } = usePosBranch();
  const terminal = posPrefs.getTerminal();

  const [menu, setMenu] = useState<Menu | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [openOrders, setOpenOrders] = useState<Order[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [settings, setSettings] = useState<PosSettings | null>(null);
  const [session, setSession] = useState<CashSession | null>(null);
  const [error, setError] = useState('');

  const [tab, setTab] = useState<'mesas' | 'nueva' | 'abiertas'>('mesas');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState<string>('');
  const [search, setSearch] = useState('');
  const [pickItem, setPickItem] = useState<MenuItem | null>(null);
  const [showPay, setShowPay] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [busy, setBusy] = useState(false);

  const inOrder = Boolean(draft || order);

  const loadFloor = useCallback(() => {
    if (!branchId) return;
    api<{ zones: Zone[]; tables: DiningTable[] }>(`/pos/tables?branch_id=${branchId}`)
      .then((r) => { setZones(r.zones.filter((z) => z.active)); setTables(r.tables.filter((t) => t.active)); })
      .catch((e) => setError(errorMessage(e)));
    api<{ orders: Order[] }>(`/pos/orders?branch_id=${branchId}&status=activas`)
      .then((r) => setOpenOrders(r.orders)).catch(() => {});
  }, [branchId]);

  useEffect(() => {
    if (!branchId) return;
    setMenu(null);
    api<Menu>(`/pos/menu?branch_id=${branchId}`).then(setMenu).catch((e) => setError(errorMessage(e)));
    api<{ payment_methods: PaymentMethod[] }>('/pos/payment-methods').then((r) => setMethods(r.payment_methods)).catch(() => {});
    api<{ settings: PosSettings }>('/pos/settings').then((r) => setSettings(r.settings)).catch(() => {});
    if (posCan.cashier(role)) {
      api<{ sessions: CashSession[] }>(`/pos/cash-sessions?branch_id=${branchId}&status=abierta`)
        .then((r) => setSession(r.sessions.find((s) => s.terminal.toLowerCase() === terminal.toLowerCase()) || null))
        .catch(() => {});
    }
    loadFloor();
  }, [branchId, role, terminal, loadFloor]);

  // Refresca mesas y ordenes abiertas mientras se esta en el selector.
  useEffect(() => {
    if (inOrder) return undefined;
    const t = setInterval(loadFloor, 15000);
    return () => clearInterval(t);
  }, [inOrder, loadFloor]);

  const groupsById = useMemo(() => new Map((menu?.modifier_groups || []).map((g) => [g.id, g])), [menu]);
  const visibleItems = useMemo(() => {
    if (!menu) return [];
    const q = search.trim().toLowerCase();
    return menu.items.filter((i) => (q ? i.name.toLowerCase().includes(q) : !category || i.category_id === category));
  }, [menu, category, search]);

  const cartTotal = round2(cart.reduce((s, l) => s + (num(l.item.price) + l.modifiers.reduce((a, m) => a + num(m.price_delta), 0)) * l.quantity, 0));

  // ---------------------------------------------------------------------------
  // Acciones
  // ---------------------------------------------------------------------------

  function leave() {
    if (cart.length && !window.confirm('Hay productos sin guardar. ¿Descartarlos?')) return;
    setDraft(null);
    setOrder(null);
    setCart([]);
    setSearch('');
    loadFloor();
  }

  async function openTable(t: DiningTable) {
    setError('');
    if (t.order_id) {
      try {
        setOrder((await api<{ order: Order }>(`/pos/orders/${t.order_id}`)).order);
        setDraft(null);
      } catch (e) { setError(errorMessage(e)); }
    } else {
      setDraft(emptyDraft('comedor', t));
    }
  }

  async function openOrder(id: string) {
    try {
      setOrder((await api<{ order: Order }>(`/pos/orders/${id}`)).order);
      setDraft(null);
    } catch (e) { setError(errorMessage(e)); }
  }

  function addToCart(sel: CartSelection) {
    setCart((c) => {
      // Mismo producto sin modificadores ni notas: suma cantidad.
      if (!sel.modifiers.length && !sel.notes) {
        const same = c.find((l) => l.item.id === sel.item.id && !l.modifiers.length && !l.notes);
        if (same) return c.map((l) => (l === same ? { ...l, quantity: l.quantity + sel.quantity } : l));
      }
      return [...c, { ...sel, key: cartKey++ }];
    });
    setPickItem(null);
  }

  function clickItem(item: MenuItem) {
    if (!item.available) return;
    if (item.modifier_group_ids.some((id) => groupsById.get(id))) setPickItem(item);
    else addToCart({ item, quantity: 1, modifiers: [], notes: '' });
  }

  /** Guarda lo pendiente: crea la orden o le agrega los articulos. */
  async function save(): Promise<Order | null> {
    const items = cart.map((l) => ({
      menu_item_id: l.item.id, quantity: l.quantity, modifier_ids: l.modifiers.map((m) => m.id), notes: l.notes || null,
    }));
    let result = order;
    if (!order && draft) {
      const r = await api<{ order: Order }>('/pos/orders', {
        method: 'POST',
        body: {
          branch_id: branchId,
          order_type: draft.order_type,
          table_id: draft.table?.id,
          guests: draft.guests ? Number(draft.guests) : null,
          customer_name: draft.customer_name || null,
          customer_phone: draft.customer_phone || null,
          customer_address: draft.customer_address || null,
          items,
        },
      });
      result = r.order;
      setDraft(null);
    } else if (order && items.length) {
      result = (await api<{ order: Order }>(`/pos/orders/${order.id}/items`, { method: 'POST', body: { items } })).order;
    }
    setCart([]);
    setOrder(result);
    return result;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  const doSave = () => run(async () => { await save(); });
  const doSend = () => run(async () => {
    const o = await save();
    if (!o) return;
    setOrder((await api<{ order: Order }>(`/pos/orders/${o.id}/send`, { method: 'POST' })).order);
  });
  const doCharge = () => run(async () => {
    if (!session) throw new Error(`Abre la caja "${terminal}" para cobrar`);
    const o = await save();
    if (o) setShowPay(true);
  });
  const doDiscount = () => run(async () => { if (await save()) setShowDiscount(true); });
  const doCancel = () => run(async () => {
    if (!order) { leave(); return; }
    const reason = window.prompt('Motivo de la cancelación');
    if (!reason) return;
    await api(`/pos/orders/${order.id}/cancel`, { method: 'POST', body: { reason } });
    setOrder(null);
    setCart([]);
    loadFloor();
  });
  const removeItem = (itemId: string, sent: boolean) => run(async () => {
    if (!order) return;
    let reason: string | null = null;
    if (sent) {
      reason = window.prompt('Este artículo ya se envió a cocina. Motivo de la cancelación:');
      if (!reason) return;
    }
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    setOrder((await api<{ order: Order }>(`/pos/orders/${order.id}/items/${itemId}${q}`, { method: 'DELETE' })).order);
  });
  const print = (o: Order, change = 0) => printHtml(orderTicketHtml(o, me.restaurant, branch, settings, change));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!branchId) return <Alert kind="warning">No tienes sucursales asignadas.</Alert>;
  if (!menu) return error ? <Alert>{error}</Alert> : <Spinner />;

  const header = (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {inOrder && <Button variant="ghost" onClick={leave}><ArrowLeft className="h-4 w-4" /> Mesas y órdenes</Button>}
      <BranchSelect branches={branches} value={branchId} onChange={(id) => { if (!inOrder) setBranchId(id); }} />
      {posCan.cashier(role) && (
        <Link to="/admin/caja" className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ring-1
          ${session ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' : 'bg-amber-500/10 text-amber-200 ring-amber-500/30'}`}>
          <Wallet className="h-3.5 w-3.5" /> {session ? `${terminal} abierta` : `${terminal} cerrada · abrir caja`}
        </Link>
      )}
    </div>
  );

  if (!inOrder) {
    return (
      <>
        {header}
        {error && <div className="mb-4"><Alert>{error}</Alert></div>}
        <div className="mb-4 flex gap-1 rounded-xl bg-gray-900 p-1 text-sm">
          {([['mesas', 'Mesas', Utensils], ['nueva', 'Para llevar / Domicilio', ShoppingBag], ['abiertas', `Abiertas (${openOrders.length})`, ClipboardList]] as const)
            .map(([key, label, Icon]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 font-medium ${tab === key ? 'bg-brand text-brand-contrast' : 'text-gray-400 hover:text-white'}`}>
                <Icon className="h-4 w-4" /> <span className="truncate">{label}</span>
              </button>
            ))}
        </div>
        {tab === 'mesas' && <TableGrid zones={zones} tables={tables} onPick={openTable} canManage={posCan.manage(role)} />}
        {tab === 'nueva' && <NewOrderForm onStart={(d) => setDraft(d)} />}
        {tab === 'abiertas' && <OpenOrdersList orders={openOrders} onPick={openOrder} />}
      </>
    );
  }

  const items = order?.items || [];
  const title = order
    ? `${order.order_type === 'comedor' ? `Mesa ${order.table_name}` : ORDER_TYPE_LABEL[order.order_type]} · Folio ${order.folio}`
    : draft!.order_type === 'comedor' ? `Mesa ${draft!.table?.name} · nueva` : `${ORDER_TYPE_LABEL[draft!.order_type]} · nueva`;
  const customer = order ? [order.customer_name, order.customer_phone, order.customer_address].filter(Boolean).join(' · ')
    : [draft!.customer_name, draft!.customer_phone, draft!.customer_address].filter(Boolean).join(' · ');
  const unsentCount = items.filter((i) => !i.sent_at && !i.voided_at).length;
  const remaining = order ? round2(num(order.total) - num(order.paid_amount)) : 0;
  const maxPct = posCan.manage(role) ? null : num(settings?.cashier_max_discount_pct);

  return (
    <>
      {header}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Catalogo */}
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="relative min-w-[10rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input className="input pl-9" placeholder="Buscar producto" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {[{ id: '', name: 'Todo' }, ...menu.categories].map((c) => (
              <button key={c.id} onClick={() => { setCategory(c.id); setSearch(''); }}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${category === c.id && !search ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
                {c.name}
              </button>
            ))}
          </div>
          {visibleItems.length === 0 && <p className="py-10 text-center text-sm text-gray-500">No hay productos.{posCan.manage(role) && <> Agrégalos en <Link className="text-brand" to="/admin/menu">Menú</Link>.</>}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visibleItems.map((it) => (
              <button key={it.id} onClick={() => clickItem(it)} disabled={!it.available}
                className={`card flex flex-col overflow-hidden text-left transition hover:border-brand/60 ${it.available ? '' : 'cursor-not-allowed opacity-50'}`}>
                <div className="relative aspect-[4/3] w-full bg-gray-800">
                  {it.image_url
                    ? <img src={it.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    : <ImageIcon className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-gray-600" />}
                  {!it.available && <span className="absolute inset-x-0 bottom-0 bg-red-900/90 py-0.5 text-center text-xs font-semibold">Agotado</span>}
                </div>
                <div className="flex flex-1 flex-col p-2">
                  <span className="line-clamp-2 text-sm font-medium leading-tight text-white">{it.name}</span>
                  <span className="mt-auto pt-1 text-sm text-gray-400">{formatMXN(it.price)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Cuenta */}
        <aside className="card flex flex-col md:sticky md:top-20 md:max-h-[calc(100vh-6rem)]">
          <div className="border-b border-gray-800 p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold text-white">{title}</h2>
              {order && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${ORDER_STATUS_STYLE[order.status]}`}>{ORDER_STATUS_LABEL[order.status]}</span>}
            </div>
            {customer && <p className="mt-1 text-xs text-gray-400">{customer}</p>}
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto p-3">
            {items.length === 0 && cart.length === 0 && <p className="py-8 text-center text-sm text-gray-500">Toca un producto para agregarlo.</p>}
            {items.map((it) => (
              <div key={it.id} className={`rounded-lg px-2 py-1.5 text-sm ${it.voided_at ? 'opacity-40' : ''}`}>
                <div className="flex items-start gap-2">
                  <span className="w-6 text-right font-semibold text-gray-300">{it.quantity}</span>
                  <div className="min-w-0 flex-1">
                    <span className={it.voided_at ? 'line-through' : 'text-white'}>{it.name}</span>
                    {it.modifiers.map((m, i) => <div key={i} className="text-xs text-gray-400">+ {m.name}</div>)}
                    {it.notes && <div className="text-xs italic text-amber-200/80">{it.notes}</div>}
                    <div className="text-[11px] text-gray-500">{it.voided_at ? `Cancelado: ${it.void_reason}` : it.sent_at ? `En cocina ${formatTime(it.sent_at)}` : 'Sin enviar'}</div>
                  </div>
                  <span className="text-gray-300">{formatMXN(it.line_total)}</span>
                  {!it.voided_at && ['abierta', 'enviada', 'lista'].includes(order!.status) && (!it.sent_at || posCan.manage(role)) && (
                    <button onClick={() => removeItem(it.id, Boolean(it.sent_at))} className="rounded p-1 text-gray-500 hover:text-red-300" aria-label="Quitar"><Trash2 className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              </div>
            ))}
            {cart.map((l) => (
              <div key={l.key} className="rounded-lg border border-dashed border-brand/40 bg-brand/5 px-2 py-1.5 text-sm">
                <div className="flex items-start gap-2">
                  <div className="flex items-center gap-1">
                    <button className="rounded bg-gray-800 p-1" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))} aria-label="Menos"><Minus className="h-3 w-3" /></button>
                    <span className="w-5 text-center font-semibold">{l.quantity}</span>
                    <button className="rounded bg-gray-800 p-1" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x)))} aria-label="Más"><Plus className="h-3 w-3" /></button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-white">{l.item.name}</span>
                    {l.modifiers.map((m) => <div key={m.id} className="text-xs text-gray-400">+ {m.name}</div>)}
                    {l.notes && <div className="text-xs italic text-amber-200/80">{l.notes}</div>}
                  </div>
                  <button onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))} className="rounded p-1 text-gray-500 hover:text-red-300" aria-label="Quitar"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1 border-t border-gray-800 p-4 text-sm">
            {order && (
              <>
                <Row label="Subtotal" value={formatMXN(order.subtotal)} />
                {num(order.discount_amount) > 0 && <Row label={`Descuento${order.discount_type === 'percent' ? ` ${num(order.discount_value)}%` : ''}`} value={`-${formatMXN(order.discount_amount)}`} />}
                <Row label={`IVA ${num(order.tax_rate_pct)}%${order.prices_include_tax ? ' incl.' : ''}`} value={formatMXN(order.tax_amount)} />
                <Row label="Total" value={formatMXN(order.total)} strong />
                {num(order.paid_amount) > 0 && <Row label="Pagado" value={formatMXN(order.paid_amount)} />}
                {num(order.paid_amount) > 0 && <Row label="Saldo" value={formatMXN(remaining)} strong />}
              </>
            )}
            {cart.length > 0 && <Row label="Por guardar" value={formatMXN(cartTotal)} />}
          </div>

          {(!order || ['abierta', 'enviada', 'lista'].includes(order.status)) ? (
            <div className="grid grid-cols-2 gap-2 border-t border-gray-800 p-3">
              <Button variant="secondary" onClick={doSave} disabled={busy || cart.length === 0}><Save className="h-4 w-4" /> Guardar</Button>
              <Button variant="secondary" onClick={doSend} disabled={busy || (cart.length === 0 && unsentCount === 0)}><ChefHat className="h-4 w-4" /> Enviar a cocina</Button>
              {posCan.cashier(role) && (
                <Button variant="secondary" onClick={doDiscount} disabled={busy || (!order && cart.length === 0)}><Tag className="h-4 w-4" /> Descuento</Button>
              )}
              <Button variant="secondary" onClick={() => order && print(order)} disabled={!order || cart.length > 0}><Printer className="h-4 w-4" /> Cuenta</Button>
              <Button variant="ghost" onClick={doCancel} disabled={busy}><Ban className="h-4 w-4" /> {order ? 'Cancelar orden' : 'Descartar'}</Button>
              {posCan.cashier(role) && (
                <Button onClick={doCharge} disabled={busy || (!order && cart.length === 0)} className="col-span-2 py-3 text-base">
                  <CreditCard className="h-5 w-5" /> Cobrar {order ? formatMXN(remaining + cartTotal) : formatMXN(cartTotal)}
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 border-t border-gray-800 p-3">
              <Button variant="secondary" onClick={() => print(order)}><Printer className="h-4 w-4" /> Ticket</Button>
              <Button onClick={leave}>Nueva orden</Button>
            </div>
          )}
        </aside>
      </div>

      {pickItem && (
        <ModifierModal item={pickItem} onClose={() => setPickItem(null)} onAdd={addToCart}
          groups={pickItem.modifier_group_ids.map((id) => groupsById.get(id)).filter((g) => g !== undefined)} />
      )}
      {showPay && order && session && (
        <PaymentModal order={order} methods={methods} sessionId={session.id} onClose={() => setShowPay(false)}
          onPrint={print}
          onPaid={(o) => { setShowPay(false); setOrder(o); if (o.status === 'pagada') loadFloor(); }} />
      )}
      {showDiscount && order && (
        <DiscountModal order={order} maxPct={maxPct} onClose={() => setShowDiscount(false)}
          onSaved={(o) => { setShowDiscount(false); setOrder(o); }} />
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'text-base font-semibold text-white' : 'text-gray-400'}`}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function TableGrid({ zones, tables, onPick, canManage }: {
  zones: Zone[]; tables: DiningTable[]; onPick: (t: DiningTable) => void; canManage: boolean;
}) {
  if (tables.length === 0) {
    return <p className="py-10 text-center text-sm text-gray-500">No hay mesas en esta sucursal.{canManage && <> Créalas en <Link className="text-brand" to="/admin/mesas">Mesas</Link>.</>}</p>;
  }
  const sections = [...zones.map((z) => ({ id: z.id, name: z.name })), { id: null, name: zones.length ? 'Sin zona' : '' }];
  return (
    <div className="space-y-6">
      {sections.map((z) => {
        const list = tables.filter((t) => t.zone_id === z.id || (z.id === null && !zones.some((x) => x.id === t.zone_id)));
        if (!list.length) return null;
        return (
          <section key={z.id || 'none'}>
            {z.name && <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">{z.name}</h3>}
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {list.map((t) => {
                const busy = t.status === 'ocupada';
                return (
                  <button key={t.id} onClick={() => onPick(t)}
                    className={`flex aspect-square flex-col items-center justify-center rounded-2xl border-2 p-2 transition
                      ${busy ? 'border-brand bg-brand/15 text-white' : 'border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-600'}`}>
                    <span className="text-xl font-bold">{t.name}</span>
                    <span className="text-xs text-gray-400">{busy ? formatMXN(t.order_total) : `${t.capacity} pers.`}</span>
                    <span className={`mt-1 text-[11px] font-semibold ${busy ? 'text-brand' : 'text-emerald-400'}`}>
                      {busy ? `${t.order_status ? ORDER_STATUS_LABEL[t.order_status] : 'Ocupada'} · ${formatTime(t.order_created_at)}` : 'Libre'}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function NewOrderForm({ onStart }: { onStart: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(emptyDraft('para_llevar'));
  const [error, setError] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (d.order_type === 'domicilio' && (!d.customer_name.trim() || !d.customer_address.trim())) {
      setError('Para domicilio escribe el nombre y la dirección del cliente.');
      return;
    }
    onStart(d);
  };
  return (
    <form onSubmit={submit} className="card mx-auto max-w-xl space-y-4 p-5">
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-2 gap-2">
        {([['para_llevar', 'Para llevar', ShoppingBag], ['domicilio', 'Domicilio', Truck]] as const).map(([type, label, Icon]) => (
          <button key={type} type="button" onClick={() => setD({ ...d, order_type: type })}
            className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 font-semibold
              ${d.order_type === type ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-300'}`}>
            <Icon className="h-5 w-5" /> {label}
          </button>
        ))}
      </div>
      <Field label={d.order_type === 'domicilio' ? 'Nombre del cliente' : 'Nombre del cliente (opcional)'}>
        <input className="input" value={d.customer_name} maxLength={120} onChange={(e) => setD({ ...d, customer_name: e.target.value })} />
      </Field>
      <Field label="Teléfono"><input className="input" type="tel" value={d.customer_phone} maxLength={40} onChange={(e) => setD({ ...d, customer_phone: e.target.value })} /></Field>
      {d.order_type === 'domicilio' && (
        <Field label="Dirección de entrega">
          <textarea className="input" rows={2} value={d.customer_address} maxLength={400} onChange={(e) => setD({ ...d, customer_address: e.target.value })} />
        </Field>
      )}
      <Button type="submit" className="w-full py-3">Empezar orden</Button>
    </form>
  );
}

function OpenOrdersList({ orders, onPick }: { orders: Order[]; onPick: (id: string) => void }) {
  if (!orders.length) return <p className="py-10 text-center text-sm text-gray-500">No hay órdenes abiertas.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {orders.map((o) => (
        <button key={o.id} onClick={() => onPick(o.id)} className="card p-4 text-left transition hover:border-brand/60">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">Folio {o.folio}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${ORDER_STATUS_STYLE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>
          </div>
          <p className="mt-1 text-sm text-gray-300">{o.order_type === 'comedor' ? `Mesa ${o.table_name}` : ORDER_TYPE_LABEL[o.order_type]}{o.customer_name && ` · ${o.customer_name}`}</p>
          <div className="mt-2 flex justify-between text-sm text-gray-400"><span>{formatTime(o.created_at)}</span><span className="font-semibold text-white">{formatMXN(o.total)}</span></div>
        </button>
      ))}
    </div>
  );
}
