import { ArrowLeft, Banknote, CreditCard, Globe, Loader2, MapPin, PiggyBank, ShoppingBag, Store, Truck, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { cartStore, recentOrders, useCart } from './cart';
import { hasModule, useSiteCtx } from './context';
import { openLabel } from './hours';
import { CartLines, Notice } from './OrderPage';
import { pickBranch } from './portalLib';
import type { Address, CustomerOrder, PaymentStart, PortalConfig, Quote } from './types';

type OrderType = 'para_llevar' | 'domicilio';

/**
 * Checkout: sucursal, recoger o domicilio, datos de contacto (cuenta o
 * invitado), direccion, forma de pago (al recibir, o en linea con Clip si
 * el restaurante lo tiene) y notas. Los totales los calcula el servidor
 * (/portal/quote); el pedido se crea con POST /portal/orders. Con Clip el
 * servidor regresa la liga de pago y el cliente se va a Clip; al volver ve
 * /pago/resultado.
 */
export default function CheckoutPage() {
  const { site, customer } = useSiteCtx();
  const navigate = useNavigate();
  const { cart, count } = useCart();
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [orderType, setOrderType] = useState<OrderType>('para_llevar');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addressId, setAddressId] = useState<string>('new');
  const [address, setAddress] = useState('');
  const [reference, setReference] = useState('');
  const [saveAddress, setSaveAddress] = useState(true);
  // Pin del domicilio (zonas de entrega); null = el de la direccion guardada.
  const [location, setLocation] = useState<Point | null>(null);
  const [moveSaved, setMoveSaved] = useState(false);
  const [method, setMethod] = useState<'efectivo' | 'tarjeta'>('efectivo');
  const [provider, setProvider] = useState<'contra_entrega' | 'clip' | 'monedero'>('contra_entrega');
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [payWith, setPayWith] = useState('');
  const [notes, setNotes] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    portalApi<PortalConfig>('/portal/config', { noRedirect: true })
      .then((c) => {
        setConfig(c);
        const b = pickBranch(c, cartStore.get().branch_id);
        if (b && b !== cartStore.get().branch_id) cartStore.setBranch(b);
        if (!c.settings.allow_pickup && c.settings.allow_delivery) setOrderType('domicilio');
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!customer) return;
    setName((n) => n || customer.name);
    setPhone((p) => p || customer.phone || '');
    portalApi<{ addresses: Address[] }>('/portal/me', { noRedirect: true })
      .then((r) => { setAddresses(r.addresses); if (r.addresses[0]) setAddressId(r.addresses[0].id); })
      .catch(() => {});
  }, [customer]);

  const branch = config?.branches.find((b) => b.id === cart.branch_id) || null;
  const clipOption = config?.payment_options.find((o) => o.code === 'clip') || null;
  const walletOption = config?.payment_options.find((o) => o.code === 'monedero') || null;
  const payOnline = provider === 'clip' && Boolean(clipOption);
  const payWallet = provider === 'monedero' && Boolean(walletOption);
  const walletShort = payWallet && quote !== null && (walletBalance ?? 0) < quote.total;

  // Saldo del monedero (si el restaurante lo ofrece y hay sesion).
  const walletOffered = Boolean(walletOption);
  useEffect(() => {
    if (!customer || !walletOffered) { setWalletBalance(null); return; }
    portalApi<{ enabled: boolean; balance?: number }>('/portal/me/wallet', { noRedirect: true })
      .then((r) => setWalletBalance(r.enabled ? r.balance ?? 0 : null)).catch(() => setWalletBalance(null));
  }, [customer, walletOffered]);
  const deliveryOk = Boolean(config?.settings.allow_delivery && branch?.delivery_available);
  const type: OrderType = orderType === 'domicilio' && !deliveryOk ? 'para_llevar' : orderType;
  const zone = type === 'domicilio' ? branch?.delivery_zone ?? null : null;
  const usingSavedAddress = type === 'domicilio' && Boolean(customer) && addressId !== 'new' && addresses.length > 0;
  const saved = usingSavedAddress ? addresses.find((a) => a.id === addressId) : undefined;
  const savedPoint = saved?.latitude != null && saved.longitude != null
    ? { latitude: Number(saved.latitude), longitude: Number(saved.longitude) } : null;
  const point = location ?? savedPoint;
  const sendPoint = zone ? point : null;
  useEffect(() => { setLocation(null); setMoveSaved(false); }, [addressId]);
  const items = useMemo(() => cart.lines.map((l) => ({
    menu_item_id: l.item_id, quantity: l.quantity, modifier_ids: l.modifier_ids, notes: l.notes || null,
  })), [cart.lines]);

  // Cotizacion del servidor cada vez que cambia el carrito, la sucursal o el tipo.
  useEffect(() => {
    if (!config || !cart.branch_id || !items.length) { setQuote(null); return undefined; }
    let cancelled = false;
    setQuoting(true);
    const t = setTimeout(() => {
      portalApi<Quote>('/portal/quote', {
        method: 'POST', noRedirect: true,
        body: {
          branch_id: cart.branch_id, order_type: type, items, payment: { method },
          address_id: usingSavedAddress ? addressId : undefined, location: sendPoint ?? undefined,
        },
      })
        .then((q) => { if (!cancelled) { setQuote(q); setQuoteError(''); } })
        .catch((e) => { if (!cancelled) { setQuote(null); setQuoteError(errorMessage(e)); } })
        .finally(() => { if (!cancelled) setQuoting(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config, cart.branch_id, type, items, method, usingSavedAddress, addressId, sendPoint?.latitude, sendPoint?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasModule(site, 'portal')) return <p className="px-6 py-24 text-center text-gray-500">Este restaurante no tiene pedidos en línea.</p>;
  if (!config) {
    return error ? <p className="px-6 py-24 text-center text-gray-500">{error}</p>
      : <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (!count) {
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center">
        <ShoppingBag className="mx-auto h-12 w-12 text-gray-300" />
        <h1 className="mt-4 text-xl font-bold">Tu pedido está vacío</h1>
        <Link to="/pedir" className="btn-brand mt-6">Ver el menú</Link>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      const usingSaved = type === 'domicilio' && customer && addressId !== 'new';
      const res = await portalApi<{ order: CustomerOrder; payment: PaymentStart }>('/portal/orders', {
        method: 'POST',
        body: {
          branch_id: cart.branch_id,
          order_type: type,
          items,
          customer: { name: name.trim(), phone: phone.trim() },
          address_id: usingSaved ? addressId : undefined,
          address: type === 'domicilio' && !usingSaved ? { address: address.trim(), reference: reference.trim() || null } : undefined,
          save_address: Boolean(customer && saveAddress && type === 'domicilio' && !usingSaved),
          location: sendPoint ?? undefined,
          notes: notes.trim() || null,
          payment: payOnline
            ? { provider: 'clip' }
            : payWallet ? { provider: 'monedero' } : { provider: 'contra_entrega', method, pay_with: method === 'efectivo' && payWith ? Number(payWith) : null },
        },
      });
      cartStore.clear();
      recentOrders.add({ token: res.order.token, folio: res.order.folio, created_at: res.order.created_at });
      if (res.payment?.action === 'redirect' && res.payment.url) {
        window.location.assign(res.payment.url);
        return;
      }
      navigate(`/pedido/${res.order.token}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setSending(false);
    }
  }

  const choice = (on: boolean) => `flex flex-1 items-center justify-center gap-2 rounded-2xl border-2 px-3 py-3 font-semibold transition
    ${on ? 'border-brand bg-brand/5 text-gray-900' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link to="/pedir" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-brand">
        <ArrowLeft className="h-4 w-4" /> Seguir pidiendo
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Finalizar pedido</h1>

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          {!config.ordering_available && <Notice>Por ahora no estamos recibiendo pedidos en línea.</Notice>}

          <section className="card-light p-5">
            <h2 className="mb-3 font-bold">Sucursal</h2>
            {config.branches.length > 1 ? (
              <select className="input-light" value={cart.branch_id || ''} onChange={(e) => cartStore.setBranch(e.target.value)} aria-label="Sucursal">
                {config.branches.filter((b) => b.accepts_orders).map((b) => <option key={b.id} value={b.id}>{b.name} · {openLabel(b)}</option>)}
              </select>
            ) : <p className="flex items-center gap-2 font-medium"><Store className="h-4 w-4 text-brand" />{branch?.name}</p>}
            {branch && <p className="mt-2 text-sm text-gray-500">{branch.address}{branch.address && ' · '}{openLabel(branch)}</p>}

            <div className="mt-4 flex gap-3">
              {config.settings.allow_pickup && (
                <button type="button" className={choice(type === 'para_llevar')} onClick={() => setOrderType('para_llevar')}>
                  <Store className="h-5 w-5" /> Recoger
                </button>
              )}
              {deliveryOk && (
                <button type="button" className={choice(type === 'domicilio')} onClick={() => setOrderType('domicilio')}>
                  <Truck className="h-5 w-5" /> A domicilio
                </button>
              )}
            </div>
            {type === 'domicilio' && branch && (zone ? (
              <p className="mt-2 text-sm text-gray-500">
                Envío según la distancia: {zone.tiers.map((t) => `hasta ${t.radius_km} km ${formatMXN(t.fee)}`).join(' · ')}
              </p>
            ) : Number(branch.delivery_fee) > 0 && (
              <p className="mt-2 text-sm text-gray-500">Costo de envío: {formatMXN(branch.delivery_fee)}</p>
            ))}
          </section>

          <section className="card-light p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-bold">Tus datos</h2>
              {!customer && <span className="text-sm text-gray-500"><Link to="/cuenta/entrar?volver=/pedir/checkout" className="font-semibold text-brand">Inicia sesión</Link> o pide como invitado</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label-light">Nombre</span>
                <input className="input-light" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
              <label className="block"><span className="label-light">Teléfono</span>
                <input className="input-light" required type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
              </label>
            </div>
          </section>

          {type === 'domicilio' && (
            <section className="card-light p-5">
              <h2 className="mb-3 flex items-center gap-2 font-bold"><MapPin className="h-4 w-4 text-brand" /> Dirección de entrega</h2>
              {customer && addresses.length > 0 && (
                <div className="mb-3 space-y-2">
                  {addresses.map((a) => (
                    <label key={a.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${addressId === a.id ? 'border-brand bg-brand/5' : 'border-gray-200'}`}>
                      <input type="radio" name="address" className="mt-1" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                      <span><b>{a.label}</b> · {a.address}{a.reference && <span className="block text-gray-500">{a.reference}</span>}</span>
                    </label>
                  ))}
                  <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${addressId === 'new' ? 'border-brand bg-brand/5' : 'border-gray-200'}`}>
                    <input type="radio" name="address" className="mt-1" checked={addressId === 'new'} onChange={() => setAddressId('new')} /> Otra dirección
                  </label>
                </div>
              )}
              {(!customer || addressId === 'new' || !addresses.length) && (
                <div className="space-y-3">
                  <label className="block"><span className="label-light">Calle, número y colonia</span>
                    <textarea className="input-light" rows={2} required maxLength={400} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
                  </label>
                  <label className="block"><span className="label-light">Referencias (opcional)</span>
                    <input className="input-light" maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Ej. portón negro, entre calles…" />
                  </label>
                  {customer && (
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} /> Guardar en mis direcciones
                    </label>
                  )}
                </div>
              )}
              {zone && (
                <div className="mt-4 space-y-2">
                  {savedPoint && !moveSaved ? (
                    <p className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                      <MapPin className="h-4 w-4 text-brand" /> Ubicación guardada en el mapa.
                      <button type="button" className="font-semibold text-brand" onClick={() => setMoveSaved(true)}>Ajustar</button>
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-gray-800">Marca tu domicilio en el mapa</p>
                      <MapTools light near={zone.center} onPoint={setLocation} />
                      <ZoneMap className="h-64 sm:h-72" center={zone.center} tiers={zone.tiers} pin={point} onPick={setLocation} />
                      <p className="text-xs text-gray-500">Toca el mapa o arrastra el punto naranja hasta tu puerta. Así el repartidor llega directo.</p>
                    </>
                  )}
                  {quote?.delivery_distance_km != null && (
                    <p className="text-sm text-gray-700">A {Number(quote.delivery_distance_km).toFixed(1)} km · envío {formatMXN(quote.delivery_fee)}</p>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="card-light p-5">
            {(clipOption || walletOption) && (
              <>
                <h2 className="mb-3 font-bold">¿Cómo quieres pagar?</h2>
                <div className="mb-4 flex flex-col gap-3 sm:flex-row">
                  <button type="button" className={choice(!payOnline && !payWallet)} onClick={() => setProvider('contra_entrega')}>
                    <Wallet className="h-5 w-5" /> Al {type === 'domicilio' ? 'recibir' : 'recoger'}
                  </button>
                  {clipOption && (
                    <button type="button" className={choice(payOnline)} onClick={() => setProvider('clip')}>
                      <Globe className="h-5 w-5" /> {clipOption.name}
                    </button>
                  )}
                  {walletOption && (
                    <button type="button" className={choice(payWallet)} onClick={() => setProvider('monedero')}>
                      <PiggyBank className="h-5 w-5" /> Mi monedero{walletBalance !== null && ` (${formatMXN(walletBalance)})`}
                    </button>
                  )}
                </div>
              </>
            )}
            {payWallet ? (
              !customer ? (
                <p className="text-sm text-gray-600">
                  <Link to="/cuenta/entrar?volver=/pedir/checkout" className="font-semibold text-brand underline">Inicia sesión</Link> para pagar con tu monedero.
                </p>
              ) : walletShort ? (
                <p className="text-sm text-red-600">
                  Tu saldo de {formatMXN(walletBalance ?? 0)} no cubre el total. <Link to="/cuenta" className="font-semibold underline">Recarga tu monedero</Link> o elige otra forma de pago.
                </p>
              ) : (
                <p className="text-sm text-gray-600">
                  Se paga con tu saldo y el pedido llega al restaurante ya pagado.
                  {quote && walletBalance !== null && ` Te quedarán ${formatMXN(walletBalance - quote.total)}.`}
                </p>
              )
            ) : payOnline ? (
              <p className="text-sm text-gray-600">
                Te llevaremos a la página segura de Clip para pagar con tarjeta de crédito o débito. Tu pedido se envía al restaurante en cuanto se confirme el pago.
              </p>
            ) : (
              <>
                {!clipOption && <h2 className="mb-1 font-bold">Pago al {type === 'domicilio' ? 'recibir' : 'recoger'}</h2>}
                <p className="mb-3 text-sm text-gray-500">Pagas cuando recibes tu pedido.</p>
                <div className="flex gap-3">
                  <button type="button" className={choice(method === 'efectivo')} onClick={() => setMethod('efectivo')}><Banknote className="h-5 w-5" /> Efectivo</button>
                  <button type="button" className={choice(method === 'tarjeta')} onClick={() => setMethod('tarjeta')}><CreditCard className="h-5 w-5" /> Tarjeta</button>
                </div>
              </>
            )}
            {!payOnline && !payWallet && method === 'efectivo' && (
              <label className="mt-3 block"><span className="label-light">¿Con cuánto pagas? (opcional, para llevar cambio)</span>
                <input className="input-light" type="number" min={0} step="0.01" inputMode="decimal" value={payWith} onChange={(e) => setPayWith(e.target.value)} />
              </label>
            )}
            <label className="mt-3 block"><span className="label-light">Notas del pedido (opcional)</span>
              <textarea className="input-light" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </section>
        </div>

        <aside>
          <div className="card-light sticky top-24 flex flex-col">
            <h2 className="flex items-center gap-2 border-b border-gray-100 p-4 font-bold"><ShoppingBag className="h-5 w-5 text-brand" /> Tu pedido</h2>
            <CartLines />
            <div className="space-y-1 border-t border-gray-100 p-4 text-sm">
              {quote ? (
                <>
                  <Row label="Subtotal" value={formatMXN(quote.subtotal)} />
                  {quote.delivery_fee > 0 && <Row label="Envío" value={formatMXN(quote.delivery_fee)} />}
                  <Row label={`IVA ${Number(quote.tax_rate_pct)}%${quote.prices_include_tax ? ' (incluido)' : ''}`} value={formatMXN(quote.tax_amount)} muted />
                  <Row label="Total" value={formatMXN(quote.total)} strong />
                  <p className="pt-1 text-xs text-gray-500">Tiempo estimado: {quote.prep_time_minutes} min{type === 'domicilio' ? ' más el envío' : ''}.</p>
                </>
              ) : quoting ? <p className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Calculando…</p> : null}
              {quoteError && <Notice kind="error">{quoteError}</Notice>}
              {error && <Notice kind="error">{error}</Notice>}
              <button type="submit" className="btn-brand mt-2 w-full py-3.5 text-base" disabled={sending || !quote || !config.ordering_available || (payWallet && (!customer || walletShort)) || Boolean(zone && !point)}>
                {sending && <Loader2 className="h-4 w-4 animate-spin" />} {payOnline ? 'Pagar con Clip' : payWallet ? 'Pagar con monedero' : 'Hacer pedido'} {quote && `· ${formatMXN(quote.total)}`}
              </button>
            </div>
          </div>
        </aside>
      </form>
    </div>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'pt-1 text-base font-bold text-gray-900' : muted ? 'text-xs text-gray-400' : 'text-gray-600'}`}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}
