import { CalendarHeart, CheckCircle2, Loader2, MapPin, Minus, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { errorMessage, portalApi } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { hasModule, useSiteCtx } from './context';
import { Notice } from './OrderPage';
import { formatDateTimeShort } from './portalLib';

interface PublicEvent {
  event: { name: string; slug: string; place: string | null; description: string | null; sale_date: string; order_deadline: string | null; status: string; accepting: boolean; branch_name: string; branch_address: string | null; branch_phone: string | null };
  products: { id: string; name: string; description: string | null; price: string; image_url: string | null; left: number | null }[];
}
interface PublicOrder { folio: number; customer_name: string; status: string; total: string; delivered_at: string | null; public_token: string; items: { name: string; quantity: number; price: string }[] }

const key = (slug: string) => `npc_event_${slug}`;

/** Pagina publica de un evento: elegir productos y apartar el pedido (se paga al recoger). */
export default function EventPublicPage() {
  const { slug = '' } = useParams();
  const { site } = useSiteCtx();
  const [data, setData] = useState<PublicEvent | null>(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [form, setForm] = useState({ customer_name: '', customer_phone: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [order, setOrder] = useState<PublicOrder | null>(null);

  useEffect(() => {
    portalApi<PublicEvent>(`/event-page/${encodeURIComponent(slug)}`, { noRedirect: true }).then(setData).catch((e) => setError(errorMessage(e)));
    let saved: string | null = null;
    try { saved = localStorage.getItem(key(slug)); } catch { /* sin almacenamiento */ }
    if (saved) portalApi<{ order: PublicOrder }>(`/event-page/${encodeURIComponent(slug)}/orders/${saved}`, { noRedirect: true }).then((r) => setOrder(r.order)).catch(() => {});
  }, [slug]);

  if (!hasModule(site, 'eventos')) return <p className="px-6 py-24 text-center text-gray-500">Esta página no está disponible.</p>;
  if (!data) return error ? <p className="px-6 py-24 text-center text-gray-500">{error}</p> : <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  const e = data.event;
  const total = data.products.reduce((s, p) => s + Number(p.price) * (qty[p.id] || 0), 0);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await portalApi<{ order: PublicOrder }>(`/event-page/${encodeURIComponent(slug)}/orders`, { method: 'POST', noRedirect: true, body: {
        ...form, notes: form.notes || null,
        items: Object.entries(qty).filter(([, n]) => n > 0).map(([product_id, quantity]) => ({ product_id, quantity })),
      } });
      setOrder(r.order);
      setQty({});
      try { localStorage.setItem(key(slug), r.order.public_token); } catch { /* sin almacenamiento */ }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      portalApi<PublicEvent>(`/event-page/${encodeURIComponent(slug)}`, { noRedirect: true }).then(setData).catch(() => {});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="card-light p-6">
        <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-brand"><CalendarHeart className="h-4 w-4" /> {formatDay(e.sale_date)}</p>
        <h1 className="mt-1 text-3xl font-bold">{e.name}</h1>
        {e.place && <p className="mt-1 flex items-center gap-1.5 text-gray-600"><MapPin className="h-4 w-4" /> {e.place}</p>}
        {e.description && <p className="mt-3 whitespace-pre-line text-gray-700">{e.description}</p>}
        {e.order_deadline && e.accepting && <p className="mt-3 text-sm text-gray-500">Pedidos hasta el {formatDateTimeShort(e.order_deadline)}</p>}
      </div>

      {order && (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900">
          <p className="flex items-center gap-2 text-lg font-bold"><CheckCircle2 className="h-5 w-5" /> Tu pedido #{order.folio}</p>
          <ul className="mt-2 text-sm">{order.items.map((i, k) => <li key={k}>{i.quantity} × {i.name}</li>)}</ul>
          <p className="mt-2 font-semibold">Total {formatMXN(order.total)} · {order.status === 'pagado' ? (order.delivered_at ? 'Entregado' : 'Pagado') : order.status === 'cancelado' ? 'Cancelado' : 'Pagas al recoger'}</p>
          <p className="mt-1 text-sm">A nombre de {order.customer_name}. Guarda tu número de pedido.</p>
        </div>
      )}

      {!e.accepting ? (
        <div className="mt-4"><Notice>{e.status === 'terminado' ? 'Este evento ya terminó.' : 'Este evento ya no recibe pedidos por aquí.'}{e.branch_phone && ` Pregunta en ${e.branch_name}: ${e.branch_phone}.`}</Notice></div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-4">
          <ul className="card-light divide-y divide-gray-100">
            {data.products.map((p) => {
              const soldOut = p.left === 0;
              return (
                <li key={p.id} className="flex items-center gap-3 p-4">
                  {p.image_url && <img src={p.image_url} alt="" className="h-16 w-16 rounded-xl object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{p.name}</p>
                    {p.description && <p className="text-sm text-gray-600">{p.description}</p>}
                    <p className="text-sm text-gray-800">{formatMXN(p.price)}{p.left != null && <span className={soldOut ? ' text-red-600' : ' text-gray-500'}> · {soldOut ? 'agotado' : `quedan ${p.left}`}</span>}</p>
                  </div>
                  {!soldOut && (
                    <div className="flex items-center gap-2">
                      <button type="button" className="rounded-full border border-gray-300 p-2" onClick={() => setQty({ ...qty, [p.id]: Math.max(0, (qty[p.id] || 0) - 1) })} aria-label="Menos"><Minus className="h-4 w-4" /></button>
                      <span className="w-6 text-center font-semibold">{qty[p.id] || 0}</span>
                      <button type="button" className="rounded-full bg-brand p-2 text-brand-contrast disabled:opacity-40" disabled={p.left != null && (qty[p.id] || 0) >= p.left} onClick={() => setQty({ ...qty, [p.id]: (qty[p.id] || 0) + 1 })} aria-label="Más"><Plus className="h-4 w-4" /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {total > 0 && (
            <div className="card-light space-y-3 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="label-light">Tu nombre</span><input className="input-light" required maxLength={120} value={form.customer_name} onChange={(ev) => setForm({ ...form, customer_name: ev.target.value })} /></label>
                <label className="block"><span className="label-light">Teléfono</span><input className="input-light" type="tel" required maxLength={30} value={form.customer_phone} onChange={(ev) => setForm({ ...form, customer_phone: ev.target.value })} /></label>
              </div>
              <label className="block"><span className="label-light">Notas (opcional)</span><input className="input-light" maxLength={500} value={form.notes} onChange={(ev) => setForm({ ...form, notes: ev.target.value })} placeholder="Ej. Área de producción, turno 2" /></label>
              {error && <Notice kind="error">{error}</Notice>}
              <button className="btn-brand w-full" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Apartar mi pedido · {formatMXN(total)}</button>
              <p className="text-center text-xs text-gray-500">Pagas al recoger tu pedido.</p>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
