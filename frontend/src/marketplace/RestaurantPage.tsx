import { ArrowLeft, Banknote, Bike, Clock, CreditCard, MapPin, Minus, Plus, ShoppingBag, Store } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ZoneMap, { type Point } from '../components/ZoneMap';
import { Alert, Button, Field, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import ItemModal from '../site/ItemModal';
import type { PortalItem, PortalMenu } from '../site/types';
import {
  addToCart, cartStore, cartTotal, clearCart, contactStore, locationStore, ordersStore, setQuantity, useStore,
} from './customer';
import { REASON_LABEL, type NearbyRestaurant } from './lib';

interface Quote { totals: { subtotal: string | number; delivery_fee: string | number; total: string | number } }

/**
 * Menu de un restaurante en NeuronPOS Delivery, carrito y datos de entrega.
 * Pago en efectivo al recibir o con tarjeta (Clip de NeuronPOS). El
 * servidor vuelve a valuar todo y rechaza el pedido si ya no hay
 * repartidores conectados que cubran al restaurante.
 */
export default function RestaurantPage() {
  const { branchId = '' } = useParams();
  const navigate = useNavigate();
  const location = useStore(locationStore);
  const cart = useStore(cartStore);
  const contact = useStore(contactStore);
  const [data, setData] = useState<(PortalMenu & { restaurant: NearbyRestaurant }) | null>(null);
  const [error, setError] = useState('');
  const [item, setItem] = useState<PortalItem | null>(null);
  const [checkout, setCheckout] = useState(false);

  const load = useCallback(() => {
    const q = location ? `?lat=${location.latitude}&lng=${location.longitude}` : '';
    api<PortalMenu & { restaurant: NearbyRestaurant }>(`/marketplace/restaurants/${branchId}${q}`, { noRedirect: true })
      .then((d) => { setData(d); document.title = `${d.restaurant.name} · NeuronPOS Delivery`; })
      .catch((e) => setError(errorMessage(e)));
  }, [branchId, location]);
  useEffect(() => { resetBranding(); load(); }, [load]);

  const mine = cart.branch_id === branchId ? cart.lines : [];
  const groups = useMemo(() => new Map((data?.modifier_groups || []).map((g) => [g.id, g])), [data]);

  if (!data) return <Page>{error ? <Alert>{error}</Alert> : <Spinner />}</Page>;
  const r = data.restaurant;
  const count = mine.reduce((s, l) => s + l.quantity, 0);

  return (
    <Page>
      <Link to="/delivery" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Restaurantes</Link>
      <header className="card mb-6 flex flex-wrap items-center gap-4 p-5">
        {r.logo_url ? <img src={r.logo_url} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <div className="rounded-xl bg-gray-800 p-4"><Store className="h-8 w-8 text-gray-500" /></div>}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-white">{r.name}</h1>
          {(r.cuisine || r.description) && <p className="text-sm text-gray-400">{[r.cuisine, r.description].filter(Boolean).join(' · ')}</p>}
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-400">
            <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {r.prep_minutes + 15} min aprox.</span>
            {r.delivery_fee !== null && <span className="flex items-center gap-1"><Bike className="h-3.5 w-3.5" /> Envío {formatMXN(r.delivery_fee)}</span>}
            {r.min_order > 0 && <span>Mínimo {formatMXN(r.min_order)}</span>}
          </p>
        </div>
        {!r.can_order && r.reason && <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/40">{REASON_LABEL[r.reason]}</span>}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {data.categories.map((c) => (
            <section key={c.id}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-400">{c.name}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {data.items.filter((i) => i.category_id === c.id).map((i) => (
                  <button key={i.id} type="button" disabled={!i.available} onClick={() => setItem(i)}
                    className="card flex items-center gap-3 p-3 text-left transition hover:border-brand/60 disabled:opacity-50">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white">{i.name}</div>
                      {i.description && <div className="line-clamp-2 text-xs text-gray-400">{i.description}</div>}
                      <div className="mt-1 text-sm font-semibold text-brand">{formatMXN(i.price)}</div>
                    </div>
                    {i.image_url && <img src={i.image_url} alt="" className="h-16 w-16 rounded-lg object-cover" />}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <section className="card p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold text-white"><ShoppingBag className="h-5 w-5 text-brand" /> Tu pedido</h2>
            {mine.length === 0 ? <p className="text-sm text-gray-500">Agrega productos del menú.</p> : (
              <>
                <ul className="divide-y divide-gray-800">
                  {mine.map((l) => (
                    <li key={l.key} className="flex items-start gap-2 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="text-gray-100">{l.name}</div>
                        {l.modifier_names.length > 0 && <div className="text-xs text-gray-500">{l.modifier_names.join(', ')}</div>}
                        <div className="text-xs text-gray-400">{formatMXN(l.unit_price * l.quantity)}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button type="button" className="rounded bg-gray-800 p-1" onClick={() => setQuantity(l.key, l.quantity - 1)} aria-label="Menos"><Minus className="h-3.5 w-3.5" /></button>
                        <span className="w-6 text-center text-white">{l.quantity}</span>
                        <button type="button" className="rounded bg-gray-800 p-1" onClick={() => setQuantity(l.key, l.quantity + 1)} aria-label="Más"><Plus className="h-3.5 w-3.5" /></button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-between border-t border-gray-800 pt-2 text-sm text-gray-300"><span>Productos ({count})</span><span>{formatMXN(cartTotal({ ...cart, lines: mine }))}</span></div>
                {r.delivery_fee !== null && <div className="flex justify-between text-sm text-gray-300"><span>Envío</span><span>{formatMXN(r.delivery_fee)}</span></div>}
                {!checkout && (
                  <Button className="mt-3 w-full" disabled={!r.can_order} onClick={() => setCheckout(true)}>
                    {r.can_order ? 'Continuar' : REASON_LABEL[r.reason || 'sin_repartidor']}
                  </Button>
                )}
              </>
            )}
          </section>
          {checkout && mine.length > 0 && (
            <Checkout branchId={branchId} restaurant={r} location={location} contact={contact}
              lines={mine} onDone={(token, paymentUrl) => {
                ordersStore.set([{ token, restaurant: r.name, at: new Date().toISOString() }, ...ordersStore.get()].slice(0, 10));
                clearCart();
                if (paymentUrl) window.location.assign(paymentUrl);
                else navigate(`/delivery/pedido/${token}`);
              }} onRefresh={load} />
          )}
        </aside>
      </div>

      {item && (
        <ItemModal item={item} groups={item.modifier_group_ids.map((id) => groups.get(id)).filter((g): g is NonNullable<typeof g> => Boolean(g))}
          onClose={() => setItem(null)} onAdd={(line) => { addToCart(branchId, r.name, line); setItem(null); }} />
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gray-950"><div className="mx-auto max-w-5xl px-4 py-6">{children}</div></div>;
}

function Checkout({ branchId, restaurant, location, contact, lines, onDone, onRefresh }: {
  branchId: string; restaurant: NearbyRestaurant; location: Point | null; contact: { name: string; phone: string; address: string; reference: string };
  lines: { item_id: string; quantity: number; modifier_ids: string[]; notes: string }[]; onDone: (token: string, paymentUrl?: string) => void; onRefresh: () => void;
}) {
  const [f, setF] = useState({ ...contact, notes: '', payWith: '' });
  const [method, setMethod] = useState<'efectivo' | 'tarjeta'>('efectivo');
  const [cards, setCards] = useState(false);
  useEffect(() => {
    api<{ card_payments: boolean }>('/marketplace/info', { noRedirect: true }).then((i) => setCards(i.card_payments)).catch(() => {});
  }, []);
  const [pin, setPin] = useState<Point | null>(location);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const body = useMemo(() => ({
    branch_id: branchId,
    items: lines.map((l) => ({ menu_item_id: l.item_id, quantity: l.quantity, modifier_ids: l.modifier_ids, notes: l.notes || null })),
    location: pin,
  }), [branchId, lines, pin]);

  useEffect(() => {
    if (!pin) return;
    api<Quote>('/marketplace/quote', { method: 'POST', body, noRedirect: true })
      .then((q) => { setQuote(q); setError(''); })
      .catch((e) => setError(errorMessage(e)));
  }, [body, pin]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      contactStore.set({ name: f.name, phone: f.phone, address: f.address, reference: f.reference });
      const r = await api<{ order: { token: string; payment_url?: string } }>('/marketplace/orders', {
        method: 'POST', noRedirect: true,
        body: {
          ...body, customer: { name: f.name, phone: f.phone }, address: { address: f.address, reference: f.reference || null },
          notes: f.notes || null, payment_method: method,
          pay_with: method === 'efectivo' && f.payWith ? Number(f.payWith) : null,
        },
      });
      onDone(r.order.token, r.order.payment_url);
    } catch (err) {
      setError(errorMessage(err));
      onRefresh();
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="card mt-4 space-y-3 p-4">
      <h2 className="flex items-center gap-2 font-semibold text-white"><MapPin className="h-5 w-5 text-brand" /> Entrega</h2>
      <ZoneMap className="h-40" center={null} tiers={[]} pin={pin} onPick={setPin} />
      <p className="text-xs text-gray-500">Arrastra el pin a tu puerta.</p>
      <Field label="Dirección"><input className="input" required maxLength={400} value={f.address} onChange={set('address')} placeholder="Calle, número y colonia" /></Field>
      <Field label="Referencia"><input className="input" maxLength={200} value={f.reference} onChange={set('reference')} placeholder="Portón azul, entre calles…" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Nombre"><input className="input" required maxLength={120} value={f.name} onChange={set('name')} /></Field>
        <Field label="Teléfono"><input className="input" type="tel" required value={f.phone} onChange={set('phone')} /></Field>
      </div>
      <Field label="Notas para el restaurante"><input className="input" maxLength={500} value={f.notes} onChange={set('notes')} /></Field>
      <div className="space-y-3 rounded-xl bg-gray-950/60 p-3 text-sm text-gray-300">
        {cards && (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Forma de pago">
            {([['efectivo', 'Efectivo', Banknote], ['tarjeta', 'Tarjeta', CreditCard]] as const).map(([k, label, Icon]) => (
              <button key={k} type="button" role="radio" aria-checked={method === k} onClick={() => setMethod(k)}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 font-medium ${method === k ? 'border-brand bg-brand/10 text-white' : 'border-gray-700 text-gray-400 hover:text-white'}`}>
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
        )}
        {method === 'efectivo' ? (
          <>
            <p className="font-medium text-white">Pago en efectivo al recibir</p>
            <Field label="¿Con cuánto pagas?" hint="Para que el repartidor lleve cambio">
              <input className="input" type="number" min={0} step={1} value={f.payWith} onChange={set('payWith')} />
            </Field>
          </>
        ) : (
          <p>Pagas en línea con tarjeta (Clip). El restaurante recibe tu pedido en cuanto se confirma el pago.</p>
        )}
      </div>
      {quote && (
        <div className="space-y-1 text-sm">
          <div className="flex justify-between text-gray-300"><span>Productos</span><span>{formatMXN(quote.totals.subtotal)}</span></div>
          <div className="flex justify-between text-gray-300"><span>Envío</span><span>{formatMXN(quote.totals.delivery_fee)}</span></div>
          <div className="flex justify-between text-base font-semibold text-white"><span>Total</span><span>{formatMXN(quote.totals.total)}</span></div>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <Button type="submit" loading={busy} disabled={!quote || !restaurant.can_order} className="w-full">{method === 'tarjeta' ? 'Pagar con tarjeta' : 'Hacer pedido'}</Button>
    </form>
  );
}
