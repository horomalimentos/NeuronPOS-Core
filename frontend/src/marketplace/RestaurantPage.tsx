import { ArrowLeft, Banknote, Bike, Clock, CreditCard, MapPin, Minus, Plus, ShoppingBag, Store, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useNayoFavicon } from '../components/useNayoFavicon';
import ZoneMap, { type Point } from '../components/ZoneMap';
import { Alert, Button, Field, Spinner } from '../components/ui';
import { api, errorMessage, nayoApi, ApiError } from '../lib/api';
import { useNayoLive } from '../lib/live';
import NayoAccountForm, { VerifyEmailForm } from './NayoAccountForm';
import { resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import ItemModal from '../site/ItemModal';
import type { PortalItem, PortalMenu } from '../site/types';
import {
  accountStore, addToCart, cartStore, cartTotal, clearCart, contactStore, locationStore, ordersStore, setQuantity, signOut, useStore,
} from './customer';
import ActiveOrderBubble from './ActiveOrderBubble';
import { CUISINE_EMOJI, etaText, REASON_LABEL, type NearbyRestaurant } from './lib';
import { nayoPath } from './nayoUrl';

interface Quote { totals: { subtotal: string | number; delivery_fee: string | number; total: string | number } }

/**
 * Menu de un restaurante en Nayo, carrito y datos de entrega.
 * Pago en efectivo al recibir o con tarjeta (Stripe o Clip de NeuronPOS). El
 * servidor vuelve a valuar todo y rechaza el pedido si ya no hay
 * repartidores conectados que cubran al restaurante.
 */
export default function RestaurantPage() {
  const { branchId = '' } = useParams();
  useNayoFavicon();
  const navigate = useNavigate();
  const location = useStore(locationStore);
  const cart = useStore(cartStore);
  const contact = useStore(contactStore);
  const [data, setData] = useState<(PortalMenu & { restaurant: NearbyRestaurant }) | null>(null);
  const [error, setError] = useState('');
  const [item, setItem] = useState<PortalItem | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [sheet, setSheet] = useState(false);
  const wide = useWide();

  const load = useCallback(() => {
    const q = location ? `?lat=${location.latitude}&lng=${location.longitude}` : '';
    api<PortalMenu & { restaurant: NearbyRestaurant }>(`/marketplace/restaurants/${branchId}${q}`, { noRedirect: true })
      .then((d) => { setData(d); document.title = `${d.restaurant.name} · Nayo`; })
      .catch((e) => setError(errorMessage(e)));
  }, [branchId, location]);
  useEffect(() => { resetBranding(); load(); }, [load]);
  // Si se conecta o desconecta un repartidor, se sabe al instante si ya se puede pedir.
  useNayoLive(load);

  const mine = cart.branch_id === branchId ? cart.lines : [];
  const groups = useMemo(() => new Map((data?.modifier_groups || []).map((g) => [g.id, g])), [data]);

  if (!data) return <Page>{error ? <Alert>{error}</Alert> : <Spinner />}</Page>;
  const r = data.restaurant;
  const count = mine.reduce((s, l) => s + l.quantity, 0);
  const subtotal = cartTotal({ ...cart, lines: mine });
  const cover = r.cover_url || data.items.find((i) => i.image_url)?.image_url || null;
  const featured = data.items.filter((i) => i.image_url && i.available).slice(0, 8);
  const categories = data.categories.filter((c) => data.items.some((i) => i.category_id === c.id));
  const qtyOf = (id: string) => mine.filter((l) => l.item_id === id).reduce((s, l) => s + l.quantity, 0);

  const cartPanel = (
    <>
      <section className="card p-4">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-white"><ShoppingBag className="h-5 w-5 text-brand" /> Tu pedido</h2>
        {mine.length === 0 ? <p className="text-sm text-gray-500">Agrega productos del menú.</p> : (
          <>
            <ul className="divide-y divide-gray-800">
              {mine.map((l) => (
                <li key={l.key} className="flex items-start gap-3 py-2 text-sm">
                  {l.image_url && <img src={l.image_url} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-gray-100">{l.name}</div>
                    {l.modifier_names.length > 0 && <div className="text-xs text-gray-500">{l.modifier_names.join(', ')}</div>}
                    <div className="text-xs text-gray-400">{formatMXN(l.unit_price * l.quantity)}</div>
                  </div>
                  <div className="flex items-center gap-1 rounded-full bg-gray-800 p-0.5">
                    <button type="button" className="rounded-full p-1.5 hover:bg-gray-700" onClick={() => setQuantity(l.key, l.quantity - 1)} aria-label="Menos"><Minus className="h-3.5 w-3.5" /></button>
                    <span className="w-5 text-center text-white">{l.quantity}</span>
                    <button type="button" className="rounded-full p-1.5 hover:bg-gray-700" onClick={() => setQuantity(l.key, l.quantity + 1)} aria-label="Más"><Plus className="h-3.5 w-3.5" /></button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-gray-800 pt-2 text-sm text-gray-300"><span>Productos ({count})</span><span>{formatMXN(subtotal)}</span></div>
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
            else navigate(nayoPath(`/pedido/${token}`));
          }} onRefresh={load} />
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-gray-950 pb-28">
      {/* Portada grande, como en las apps de reparto */}
      <div className="relative h-48 bg-gray-900 sm:h-64">
        {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-gradient-to-br from-brand/30 to-gray-900" />}
        <div className="absolute inset-0 bg-gradient-to-t from-gray-950 via-gray-950/30 to-transparent" />
        <Link to={nayoPath()} className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-gray-950/80 text-white shadow-lg backdrop-blur hover:bg-gray-900" aria-label="Restaurantes">
          <ArrowLeft className="h-5 w-5" />
        </Link>
      </div>
      <div className="mx-auto max-w-5xl px-4">
        <header className="relative -mt-12 mb-4 flex items-end gap-4">
          {r.logo_url
            ? <img src={r.logo_url} alt="" className="h-24 w-24 shrink-0 rounded-2xl border-4 border-gray-950 object-cover shadow-xl" />
            : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl border-4 border-gray-950 bg-gray-800 shadow-xl"><Store className="h-10 w-10 text-gray-500" /></div>}
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="truncate text-2xl font-extrabold text-white sm:text-3xl">{r.name}</h1>
            {r.cuisine && <p className="text-sm text-gray-400">{CUISINE_EMOJI[r.cuisine] || ''} {r.cuisine}</p>}
          </div>
        </header>
        {r.description && <p className="mb-3 text-sm text-gray-400">{r.description}</p>}
        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 text-sm">
          <InfoPill><Clock className="h-4 w-4 text-brand" /> {etaText(r.prep_minutes)}</InfoPill>
          {r.delivery_fee !== null && <InfoPill><Bike className="h-4 w-4 text-brand" /> Envío {formatMXN(r.delivery_fee)}</InfoPill>}
          {r.distance_km !== null && <InfoPill><MapPin className="h-4 w-4 text-brand" /> {r.distance_km.toFixed(1)} km</InfoPill>}
          {r.min_order > 0 && <InfoPill>Mínimo {formatMXN(r.min_order)}</InfoPill>}
        </div>
        {!r.can_order && r.reason && (
          <div className="mb-4 rounded-xl bg-amber-500/15 px-4 py-3 text-sm font-semibold text-amber-300 ring-1 ring-amber-500/40">{REASON_LABEL[r.reason]}</div>
        )}
      </div>

      {/* Categorias fijas arriba al bajar por el menu */}
      {categories.length > 1 && (
        <nav className="sticky top-0 z-30 border-b border-gray-900 bg-gray-950/95 backdrop-blur">
          <div className="no-scrollbar mx-auto flex max-w-5xl gap-2 overflow-x-auto px-4 py-2">
            {categories.map((c) => (
              <a key={c.id} href={`#cat-${c.id}`} className="shrink-0 rounded-full bg-gray-800 px-4 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-700">{c.name}</a>
            ))}
          </div>
        </nav>
      )}

      <div className="mx-auto grid max-w-5xl gap-6 px-4 pt-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-8">
          {featured.length >= 2 && (
            <section>
              <h2 className="mb-3 text-xl font-bold text-white">Destacados</h2>
              <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
                {featured.map((i) => (
                  <button key={i.id} type="button" onClick={() => setItem(i)} className="w-40 shrink-0 text-left sm:w-48">
                    <div className="relative aspect-square overflow-hidden rounded-2xl bg-gray-900">
                      <img src={i.image_url || ''} alt="" className="h-full w-full object-cover transition hover:scale-105" loading="lazy" />
                      <AddBadge qty={qtyOf(i.id)} />
                    </div>
                    <div className="mt-2 line-clamp-2 text-sm font-medium text-white">{i.name}</div>
                    <div className="text-sm font-semibold text-brand">{formatMXN(i.price)}</div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {categories.map((c) => (
            <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-16">
              <h2 className="mb-3 text-xl font-bold text-white">{c.name}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {data.items.filter((i) => i.category_id === c.id).map((i) => (
                  <button key={i.id} type="button" disabled={!i.available} onClick={() => setItem(i)}
                    className="flex min-h-[7.5rem] items-stretch gap-3 rounded-2xl border border-gray-800 bg-gray-900/60 p-3 text-left transition hover:border-brand/60 hover:bg-gray-900 disabled:opacity-50">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="font-semibold text-white">{i.name}</div>
                      {i.description && <div className="mt-0.5 line-clamp-2 text-sm text-gray-400">{i.description}</div>}
                      <div className="mt-auto pt-2 font-semibold text-brand">{i.available ? formatMXN(i.price) : 'Agotado'}</div>
                    </div>
                    <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-gray-800 sm:h-28 sm:w-28">
                      {i.image_url
                        ? <img src={i.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                        : <div className="flex h-full w-full items-center justify-center text-3xl text-gray-600">🍽️</div>}
                      {i.available && <AddBadge qty={qtyOf(i.id)} />}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Escritorio: carrito a un lado. Celular: barra flotante que abre el carrito abajo. */}
        <aside className="hidden lg:sticky lg:top-16 lg:block lg:self-start">{wide && cartPanel}</aside>
      </div>

      {!wide && count > 0 && !sheet && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={() => setSheet(true)}
            className="mx-auto flex w-full max-w-md items-center gap-3 rounded-full bg-brand px-5 py-3.5 font-bold text-brand-contrast shadow-2xl shadow-black/60">
            <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-gray-950/20 px-2 text-sm">{count}</span>
            <span className="flex-1 text-left">Ver pedido</span>
            <span>{formatMXN(subtotal)}</span>
          </button>
        </div>
      )}
      {!wide && sheet && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60" role="dialog" aria-modal="true" aria-label="Tu pedido" onClick={() => setSheet(false)}>
          <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-gray-950 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="mx-auto h-1.5 w-12 rounded-full bg-gray-700" />
              <button type="button" onClick={() => setSheet(false)} className="absolute right-6 rounded-full bg-gray-800 p-2 text-gray-300" aria-label="Cerrar"><X className="h-4 w-4" /></button>
            </div>
            {cartPanel}
          </div>
        </div>
      )}

      <ActiveOrderBubble branchId={branchId} raised={!wide && count > 0} />
      {item && (
        <ItemModal item={item} groups={item.modifier_group_ids.map((id) => groups.get(id)).filter((g): g is NonNullable<typeof g> => Boolean(g))}
          onClose={() => setItem(null)} onAdd={(line) => { addToCart(branchId, r.name, line); setItem(null); }} />
      )}
    </div>
  );
}

function InfoPill({ children }: { children: React.ReactNode }) {
  return <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-gray-200 ring-1 ring-gray-800">{children}</span>;
}

/** Boton "+" sobre la foto; si ya esta en el carrito, muestra cuantos llevas. */
function AddBadge({ qty }: { qty: number }) {
  return (
    <span className={`absolute bottom-2 right-2 flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm font-bold shadow-lg ${qty ? 'bg-brand text-brand-contrast' : 'bg-white text-gray-900'}`}>
      {qty || <Plus className="h-4 w-4" />}
    </span>
  );
}

/** true en pantallas anchas (lg de Tailwind), donde el carrito va a un lado. */
function useWide() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gray-950"><div className="mx-auto max-w-5xl px-4 py-6">{children}</div></div>;
}

function Checkout({ branchId, restaurant, location, contact, lines, onDone, onRefresh }: {
  branchId: string; restaurant: NearbyRestaurant; location: Point | null; contact: { name: string; phone: string; address: string; reference: string };
  lines: { item_id: string; quantity: number; modifier_ids: string[]; notes: string }[]; onDone: (token: string, paymentUrl?: string) => void; onRefresh: () => void;
}) {
  const account = useStore(accountStore);
  // Para pedir hay que tener cuenta de Nayo.
  if (!account || account.email_verified === false) {
    return (
      <div className="card mt-4 space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-white">
          <UserRound className="h-5 w-5 text-brand" /> {account ? 'Confirma tu correo' : 'Tu cuenta'}
        </h2>
        {account ? <VerifyEmailForm account={account} /> : <NayoAccountForm />}
      </div>
    );
  }
  return <CheckoutForm key={account.id} {...{ branchId, restaurant, location, lines, onDone, onRefresh }}
    contact={{ ...contact, name: contact.name || account.name, phone: contact.phone || account.phone || '' }} account={account} />;
}

function CheckoutForm({ branchId, restaurant, location, contact, account, lines, onDone, onRefresh }: {
  branchId: string; restaurant: NearbyRestaurant; location: Point | null; contact: { name: string; phone: string; address: string; reference: string };
  account: { name: string; email: string };
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
      const r = await nayoApi<{ order: { token: string; payment_url?: string } }>('/marketplace/orders', {
        method: 'POST',
        body: {
          ...body, customer: { name: f.name, phone: f.phone }, address: { address: f.address, reference: f.reference || null },
          notes: f.notes || null, payment_method: method,
          pay_with: method === 'efectivo' && f.payWith ? Number(f.payWith) : null,
        },
      });
      onDone(r.order.token, r.order.payment_url);
    } catch (err) {
      // Sesion vencida o cuenta borrada: vuelve a pedir que entre.
      if (err instanceof ApiError && err.status === 401) { signOut(); setBusy(false); return; }
      setError(errorMessage(err));
      onRefresh();
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="card mt-4 space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
        <span className="flex items-center gap-1"><UserRound className="h-3.5 w-3.5" /> Pides como <span className="font-medium text-gray-200">{account.name}</span> ({account.email})</span>
        <button type="button" onClick={signOut} className="underline hover:text-white">No soy yo</button>
      </div>
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
          <p>Pagas en línea con tarjeta. El restaurante recibe tu pedido en cuanto se confirma el pago.</p>
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
