import { ArrowLeft, Check, ExternalLink, Minus, PackageCheck, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { formatDateTime, posCan } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import { EventModal } from './EventsPage';
import { EVENT_STATUS, type EventOrder, type EventProduct, type EventStatus, type SaleEvent } from './types';

type Tab = 'pedidos' | 'productos' | 'produccion' | 'vendedores';

export default function EventDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAdmin();
  const manager = posCan.manage(me.user.role);
  const [data, setData] = useState<{ event: SaleEvent; products: EventProduct[] } | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('pedidos');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => { api<{ event: SaleEvent; products: EventProduct[] }>(`/events/${id}`).then(setData).catch((e) => setError(errorMessage(e))); }, [id]);
  useEffect(load, [load]);

  async function setStatus(status: EventStatus) {
    try {
      const r = await api<{ event: SaleEvent }>(`/events/${id}`, { method: 'PATCH', body: { status } });
      setData((d) => (d ? { ...d, event: r.event } : d));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const e = data.event;
  const url = `${window.location.origin}/evento/${e.slug}`;
  const tabs: [Tab, string][] = [['pedidos', 'Pedidos'], ['produccion', 'Producción'], ...(manager ? [['productos', 'Productos'], ['vendedores', 'Vendedores']] as [Tab, string][] : [])];
  return (
    <>
      <Link to="/admin/eventos" className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Eventos</Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{e.name}</h1>
          <p className="text-sm text-gray-400">{formatDay(e.sale_date)}{e.place && ` · ${e.place}`} · prepara {e.branch_name}{e.order_deadline && ` · pedidos hasta ${formatDateTime(e.order_deadline)}`}</p>
          <a href={url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-brand"><ExternalLink className="h-3.5 w-3.5" /> {url}</a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${EVENT_STATUS[e.status][1]}`}>{EVENT_STATUS[e.status][0]}</span>
          {manager && (
            <>
              <select className="input w-auto py-1.5 text-sm" value={e.status} onChange={(ev) => setStatus(ev.target.value as EventStatus)} aria-label="Estado">
                {(Object.keys(EVENT_STATUS) as EventStatus[]).map((s) => <option key={s} value={s}>{EVENT_STATUS[s][0]}</option>)}
              </select>
              <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Editar</Button>
            </>
          )}
        </div>
      </div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {e.status === 'borrador' && <div className="mb-3"><Alert kind="warning">El evento está en borrador: agrega los productos y ábrelo para recibir pedidos.</Alert></div>}
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-gray-900 p-1 text-sm sm:flex sm:w-fit">
        {tabs.map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-4 py-2 font-medium ${tab === t ? 'bg-brand text-brand-contrast' : 'text-gray-400 hover:text-white'}`}>{l}</button>
        ))}
      </div>
      {tab === 'pedidos' && <Orders event={e} products={data.products} onChanged={load} />}
      {tab === 'productos' && <Products event={e} products={data.products} onSaved={(p) => setData((d) => (d ? { ...d, products: p } : d))} />}
      {tab === 'produccion' && <Production eventId={e.id} />}
      {tab === 'vendedores' && <Sellers event={e} />}
      {editing && <EventModal event={e} onClose={() => setEditing(false)} onSaved={(ev) => { setEditing(false); setData((d) => (d ? { ...d, event: ev } : d)); }} />}
    </>
  );
}

const ORDER_STATUS = { pendiente: ['Por cobrar', 'text-amber-300'], pagado: ['Pagado', 'text-emerald-300'], cancelado: ['Cancelado', 'text-gray-500 line-through'] } as const;

function Orders({ event, products, onChanged }: { event: SaleEvent; products: EventProduct[]; onChanged: () => void }) {
  const [orders, setOrders] = useState<EventOrder[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const load = useCallback(() => { api<{ orders: EventOrder[] }>(`/events/${event.id}/orders`).then((r) => setOrders(r.orders)).catch((e) => setError(errorMessage(e))); }, [event.id]);
  useEffect(load, [load]);
  async function act(o: EventOrder, action: 'pay' | 'deliver' | 'cancel') {
    if (action === 'cancel' && !confirm(`¿Cancelar el pedido ${o.folio} de ${o.customer_name}?`)) return;
    try {
      const r = await api<{ order: EventOrder }>(`/events/orders/${o.id}/${action}`, { method: 'POST', body: {} });
      setOrders((list) => (list || []).map((x) => (x.id === o.id ? r.order : x)));
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const shown = (orders || []).filter((o) => !q || `${o.folio} ${o.customer_name} ${o.customer_phone || ''}`.toLowerCase().includes(q.toLowerCase()));
  const open = ['abierto', 'cerrado'].includes(event.status);
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input max-w-xs flex-1" placeholder="Buscar folio, nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} />
        {open && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo pedido</Button>}
      </div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!orders ? <Spinner /> : (
        <ul className="card divide-y divide-gray-800 text-sm">
          {shown.length === 0 && <li className="p-6 text-center text-gray-500">Sin pedidos.</li>}
          {shown.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="w-10 font-bold text-white">{o.folio}</span>
              <div className="min-w-0 flex-1">
                <p className="text-white">{o.customer_name}{o.customer_phone && <span className="text-gray-500"> · {o.customer_phone}</span>}</p>
                <p className="text-gray-400">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}{o.notes && ` · “${o.notes}”`}</p>
                <p className="text-xs text-gray-500">{o.seller_name ? `Vendió ${o.seller_name}` : 'Pidió en la página'} · {formatDateTime(o.created_at)}</p>
              </div>
              <span className="font-semibold text-white">{formatMXN(o.total)}</span>
              <span className={`w-24 text-xs font-semibold ${ORDER_STATUS[o.status][1]}`}>{o.delivered_at ? 'Entregado' : ORDER_STATUS[o.status][0]}</span>
              <div className="flex gap-1">
                {o.status === 'pendiente' && <Button onClick={() => act(o, 'pay')}><Check className="h-4 w-4" /> Cobrar</Button>}
                {o.status === 'pagado' && !o.delivered_at && <Button variant="secondary" onClick={() => act(o, 'deliver')}><PackageCheck className="h-4 w-4" /> Entregar</Button>}
                {o.status !== 'cancelado' && !o.delivered_at && <button className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-red-300" onClick={() => act(o, 'cancel')} aria-label="Cancelar"><X className="h-4 w-4" /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewOrderModal event={event} products={products} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); onChanged(); }} />}
    </>
  );
}

function NewOrderModal({ event, products, onClose, onSaved }: { event: SaleEvent; products: EventProduct[]; onClose: () => void; onSaved: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [form, setForm] = useState({ customer_name: '', customer_phone: '', notes: '' });
  const [paid, setPaid] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const active = products.filter((p) => p.active);
  const total = active.reduce((s, p) => s + Number(p.price) * (qty[p.id] || 0), 0);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(`/events/${event.id}/orders`, { method: 'POST', body: {
        ...form, customer_phone: form.customer_phone || null, notes: form.notes || null, paid,
        items: Object.entries(qty).filter(([, n]) => n > 0).map(([product_id, quantity]) => ({ product_id, quantity })),
      } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Nuevo pedido" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <ul className="divide-y divide-gray-800">
          {active.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex-1 text-white">{p.name}<span className="block text-xs text-gray-500">{formatMXN(p.price)}{p.left != null && ` · quedan ${p.left - (qty[p.id] || 0)}`}</span></span>
              <button type="button" className="rounded-lg bg-gray-800 p-2" onClick={() => setQty({ ...qty, [p.id]: Math.max(0, (qty[p.id] || 0) - 1) })} aria-label="Menos"><Minus className="h-4 w-4" /></button>
              <span className="w-6 text-center text-white">{qty[p.id] || 0}</span>
              <button type="button" className="rounded-lg bg-gray-800 p-2" disabled={p.left != null && (qty[p.id] || 0) >= p.left} onClick={() => setQty({ ...qty, [p.id]: (qty[p.id] || 0) + 1 })} aria-label="Más"><Plus className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cliente"><input className="input" required maxLength={120} value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} /></Field>
          <Field label="Teléfono (opcional)"><input className="input" type="tel" maxLength={30} value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} /></Field>
        </div>
        <Field label="Notas (opcional)"><input className="input" maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Ej. Sin cebolla, área de calidad" /></Field>
        <label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Ya me pagó (efectivo)</label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-bold text-white">{formatMXN(total)}</span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={saving} disabled={total <= 0 && !Object.values(qty).some(Boolean)}>Guardar pedido</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Products({ event, products, onSaved }: { event: SaleEvent; products: EventProduct[]; onSaved: (p: EventProduct[]) => void }) {
  const blank = { id: '', name: '', description: '', price: '', max_quantity: '', image_url: '', active: true, sold: 0 };
  const [rows, setRows] = useState(products.length ? products.map((p) => ({
    id: p.id, name: p.name, description: p.description || '', price: String(Number(p.price)), max_quantity: p.max_quantity == null ? '' : String(p.max_quantity),
    image_url: p.image_url || '', active: p.active, sold: p.sold,
  })) : [blank]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);
  const upd = (i: number, patch: Partial<typeof blank>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function save() {
    setSaving(true);
    setError('');
    setOk('');
    try {
      const r = await api<{ products: EventProduct[] }>(`/events/${event.id}/products`, { method: 'PUT', body: { products: rows.filter((r) => r.name.trim()).map((r) => ({
        id: r.id || undefined, name: r.name, description: r.description || null, price: Number(r.price || 0),
        max_quantity: r.max_quantity === '' ? null : Number(r.max_quantity), image_url: r.image_url || null, active: r.active,
      })) } });
      onSaved(r.products);
      setRows(r.products.map((p) => ({ id: p.id, name: p.name, description: p.description || '', price: String(Number(p.price)), max_quantity: p.max_quantity == null ? '' : String(p.max_quantity), image_url: p.image_url || '', active: p.active, sold: p.sold })));
      setOk('Productos guardados');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="card space-y-3 p-4">
      {error && <Alert>{error}</Alert>}
      {ok && <Alert kind="success">{ok}</Alert>}
      {rows.map((r, i) => (
        <div key={i} className={`grid gap-2 rounded-xl border border-gray-800 p-3 sm:grid-cols-[2fr_1fr_1fr_auto] ${r.active ? '' : 'opacity-50'}`}>
          <input className="input" placeholder="Producto (ej. Plato de carne asada)" maxLength={120} value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
          <input className="input" type="number" min="0" step="0.01" placeholder="Precio" value={r.price} onChange={(e) => upd(i, { price: e.target.value })} />
          <input className="input" type="number" min="1" placeholder="Cupo (opcional)" value={r.max_quantity} onChange={(e) => upd(i, { max_quantity: e.target.value })} />
          <div className="flex items-center gap-1">
            <label className="flex items-center gap-1 text-xs text-gray-400"><input type="checkbox" checked={r.active} onChange={(e) => upd(i, { active: e.target.checked })} /> Activo</label>
            <button type="button" className="rounded-lg p-2 text-gray-500 hover:text-red-300" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Quitar"><Trash2 className="h-4 w-4" /></button>
          </div>
          <input className="input sm:col-span-3" placeholder="Descripción (opcional)" maxLength={500} value={r.description} onChange={(e) => upd(i, { description: e.target.value })} />
          <span className="self-center text-xs text-gray-500">{r.sold ? `${r.sold} vendidos` : ''}</span>
        </div>
      ))}
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={() => setRows([...rows, blank])}><Plus className="h-4 w-4" /> Agregar producto</Button>
        <Button onClick={save} loading={saving}>Guardar productos</Button>
      </div>
    </div>
  );
}

function Production({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<{ product_id: string; name: string; pending: number; paid: number; delivered: number }[] | null>(null);
  useEffect(() => { api<{ production: NonNullable<typeof rows> }>(`/events/${eventId}/production`).then((r) => setRows(r.production)).catch(() => setRows([])); }, [eventId]);
  if (!rows) return <Spinner />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
          <tr><th className="px-4 py-2">Producto</th><th className="px-4 py-2 text-right">A preparar</th><th className="px-4 py-2 text-right">Pagados</th><th className="px-4 py-2 text-right">Por cobrar</th><th className="px-4 py-2 text-right">Entregados</th></tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {rows.map((r) => (
            <tr key={r.product_id}>
              <td className="px-4 py-2 text-white">{r.name}</td>
              <td className="px-4 py-2 text-right text-lg font-bold text-white">{r.pending + r.paid}</td>
              <td className="px-4 py-2 text-right text-gray-300">{r.paid}</td>
              <td className="px-4 py-2 text-right text-amber-300">{r.pending}</td>
              <td className="px-4 py-2 text-right text-gray-400">{r.delivered}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sellers({ event }: { event: SaleEvent }) {
  const [rows, setRows] = useState<{ seller_id: string; name: string; orders: number; collected: string; commission: string; cash_delivered: string; commission_paid: boolean }[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<{ sellers: NonNullable<typeof rows> }>(`/events/${event.id}/sellers`).then((r) => setRows(r.sellers)).catch((e) => setError(errorMessage(e))); }, [event.id]);
  useEffect(load, [load]);
  async function update(id: string, body: object) {
    try {
      await api(`/events/${event.id}/sellers/${id}`, { method: 'PUT', body });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  if (!rows) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <p className="mb-3 text-sm text-gray-400">Lo cobrado por cada vendedor (pedidos pagados), su comisión del {Number(event.commission_pct)} % y el efectivo que ya entregó.</p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr><th className="px-4 py-2">Vendedor</th><th className="px-4 py-2 text-right">Pedidos</th><th className="px-4 py-2 text-right">Cobrado</th><th className="px-4 py-2 text-right">Comisión</th><th className="px-4 py-2 text-right">Entregó</th><th className="px-4 py-2 text-right">Debe</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-500">Sin ventas cobradas.</td></tr>}
            {rows.map((r) => {
              const owes = Number(r.collected) - Number(r.cash_delivered);
              return (
                <tr key={r.seller_id}>
                  <td className="px-4 py-2 text-white">{r.name}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.orders}</td>
                  <td className="px-4 py-2 text-right text-white">{formatMXN(r.collected)}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{formatMXN(r.commission)}{r.commission_paid && <span className="ml-1 text-xs text-emerald-300">pagada</span>}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{formatMXN(r.cash_delivered)}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${owes > 0.005 ? 'text-amber-300' : 'text-gray-500'}`}>{formatMXN(Math.max(0, owes))}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <button className="mr-2 text-xs text-brand" onClick={() => {
                      const v = window.prompt(`¿Cuánto efectivo ha entregado ${r.name}? (total)`, String(Number(r.collected) - (r.commission_paid ? 0 : Number(r.commission))));
                      if (v !== null && v.trim() !== '' && Number.isFinite(Number(v))) update(r.seller_id, { cash_delivered: Number(v) });
                    }}>Registrar entrega</button>
                    <button className="text-xs text-brand" onClick={() => update(r.seller_id, { commission_paid: !r.commission_paid })}>{r.commission_paid ? 'Comisión pendiente' : 'Comisión pagada'}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
