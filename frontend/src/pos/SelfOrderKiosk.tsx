import { CheckCircle2, ChevronLeft, Loader2, Minus, Plus, ShoppingBag, Store, Trash2, UtensilsCrossed } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { applyBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import { session } from '../lib/session';
import type { Me } from '../lib/types';
import { num, posPrefs } from './lib';
import ModifierModal, { type CartSelection } from './ModifierModal';
import type { Menu, MenuItem, Order } from './types';

const IDLE_MS = 90_000;
const DONE_MS = 15_000;
let lineKey = 1;
interface Line extends CartSelection { key: number }

/**
 * Kiosko de autoservicio (modulo "kiosko"), como el de Horom: el cliente
 * arma su orden en una tablet, elige comer aqui o para llevar, da su nombre y
 * recibe su numero para pagar en caja. Se reinicia solo si nadie lo usa.
 * Para salir: tocar el nombre del restaurante 3 veces.
 */
export default function SelfOrderKiosk() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'inicio' | 'menu' | 'revisar' | 'listo'>('inicio');
  const [dineIn, setDineIn] = useState(false);
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState<Line[]>([]);
  const [picking, setPicking] = useState<MenuItem | null>(null);
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<Order | null>(null);
  const taps = useRef<number[]>([]);
  const idle = useRef<number | undefined>(undefined);
  const branchId = posPrefs.getBranch() || me?.branches[0]?.id || '';

  const reset = useCallback(() => {
    setStep('inicio'); setCart([]); setName(''); setDone(null); setPicking(null); setError('');
  }, []);
  // Sin actividad vuelve al inicio.
  const touch = useCallback(() => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(reset, step === 'listo' ? DONE_MS : IDLE_MS);
  }, [reset, step]);
  useEffect(() => { touch(); return () => window.clearTimeout(idle.current); }, [touch, step, cart]);

  useEffect(() => {
    api<Me>('/me').then((m) => {
      setMe(m);
      applyBranding(m.restaurant.primary_color, m.restaurant.secondary_color);
    }).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    if (!branchId) return;
    api<Menu>(`/pos/menu?branch_id=${branchId}`).then((m) => {
      setMenu(m);
      setCategory((c) => c || m.categories[0]?.id || '');
    }).catch((e) => setError(errorMessage(e)));
  }, [branchId]);

  const groupsOf = useCallback((it: MenuItem) => (menu?.modifier_groups || []).filter((g) => it.modifier_group_ids.includes(g.id)), [menu]);
  const items = useMemo(() => (menu?.items || []).filter((i) => i.category_id === category && i.available), [menu, category]);
  const unit = (l: CartSelection) => num(l.item.price) + l.modifiers.reduce((s, m) => s + num(m.price_delta), 0);
  const total = cart.reduce((s, l) => s + unit(l) * l.quantity, 0);
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  if (!session.getToken('restaurant')) return <Navigate to="/admin/login" replace />;

  function add(it: MenuItem) {
    if (groupsOf(it).length) { setPicking(it); return; }
    setCart((c) => {
      const same = c.find((l) => l.item.id === it.id && !l.modifiers.length && !l.notes);
      return same ? c.map((l) => (l === same ? { ...l, quantity: l.quantity + 1 } : l)) : [...c, { key: lineKey++, item: it, quantity: 1, modifiers: [], notes: '' }];
    });
  }
  function exitTap() {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 1500), now];
    if (taps.current.length >= 3 && window.confirm('¿Salir del kiosko?')) navigate('/admin/pos');
  }
  async function send() {
    setSending(true);
    setError('');
    try {
      const r = await api<{ order: Order }>('/pos/orders', {
        method: 'POST',
        body: {
          branch_id: branchId, order_type: 'para_llevar', source: 'kiosko', dine_in: dineIn, customer_name: name.trim(),
          items: cart.map((l) => ({ menu_item_id: l.item.id, quantity: l.quantity, modifier_ids: l.modifiers.map((m) => m.id), notes: l.notes || null })),
        },
      });
      setDone(r.order);
      setStep('listo');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const r = me?.restaurant;
  return (
    <div className="site-light flex h-screen select-none flex-col overflow-hidden" onPointerDown={touch}>
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-4">
        {step === 'menu' || step === 'revisar' ? (
          <button className="rounded-full p-2 text-gray-500 hover:bg-gray-100" onClick={() => setStep(step === 'revisar' ? 'menu' : 'inicio')} aria-label="Atrás"><ChevronLeft className="h-7 w-7" /></button>
        ) : null}
        <button onClick={exitTap} className="flex min-w-0 items-center gap-3" aria-label={r?.name || 'Restaurante'}>
          {r?.logo_url ? <img src={r.logo_url} alt="" className="h-12 w-auto max-w-[10rem] object-contain" /> : <Store className="h-9 w-9 text-brand" />}
          <span className="truncate text-2xl font-bold text-gray-900">{r?.name}</span>
        </button>
        {step === 'menu' && (
          <span className="ml-auto rounded-full bg-gray-100 px-4 py-1.5 text-sm font-semibold text-gray-700">{dineIn ? 'Comer aquí' : 'Para llevar'}</span>
        )}
      </header>

      {error && <p className="bg-red-50 px-6 py-3 text-center text-red-700">{error}</p>}

      {step === 'inicio' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-10 p-8 text-center">
          <div>
            <h1 className="text-5xl font-extrabold text-gray-900">¡Bienvenido!</h1>
            <p className="mt-3 text-2xl text-gray-500">Haz tu pedido aquí y paga en caja.</p>
          </div>
          <div className="grid w-full max-w-2xl gap-6 sm:grid-cols-2">
            {[[true, 'Comer aquí', UtensilsCrossed], [false, 'Para llevar', ShoppingBag]].map(([value, label, Icon]) => {
              const I = Icon as typeof ShoppingBag;
              return (
                <button key={String(label)} onClick={() => { setDineIn(Boolean(value)); setStep('menu'); }} disabled={!menu}
                  className="flex flex-col items-center gap-4 rounded-3xl border-2 border-gray-200 bg-white p-10 text-3xl font-bold text-gray-900 shadow-sm transition active:scale-95 hover:border-brand disabled:opacity-50">
                  <I className="h-16 w-16 text-brand" /> {String(label)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {step === 'menu' && menu && (
        <div className="flex min-h-0 flex-1">
          <nav className="w-56 flex-shrink-0 space-y-2 overflow-y-auto border-r border-gray-200 bg-white p-3">
            {menu.categories.map((c) => (
              <button key={c.id} onClick={() => setCategory(c.id)}
                className={`w-full rounded-2xl px-4 py-4 text-left text-lg font-semibold ${category === c.id ? 'bg-brand text-brand-contrast' : 'text-gray-700 hover:bg-gray-100'}`}>{c.name}</button>
            ))}
          </nav>
          <main className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-4 overflow-y-auto p-5 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((it) => (
              <button key={it.id} onClick={() => add(it)} className="overflow-hidden rounded-3xl border border-gray-200 bg-white text-left shadow-sm transition active:scale-95">
                <div className="aspect-[4/3] bg-gray-100">
                  {it.image_url ? <img src={it.image_url} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-5xl font-bold text-gray-300">{it.name.slice(0, 1)}</div>}
                </div>
                <div className="p-4">
                  <p className="text-lg font-semibold leading-tight text-gray-900">{it.name}</p>
                  {it.description && <p className="mt-1 line-clamp-2 text-sm text-gray-500">{it.description}</p>}
                  <p className="mt-2 text-xl font-bold text-brand">{formatMXN(it.price)}</p>
                </div>
              </button>
            ))}
          </main>
        </div>
      )}

      {step === 'revisar' && (
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto p-6">
          <h2 className="text-3xl font-bold text-gray-900">Tu pedido</h2>
          {cart.map((l) => (
            <div key={l.key} className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-4">
              <div className="min-w-0 flex-1">
                <p className="text-xl font-semibold text-gray-900">{l.item.name}</p>
                {l.modifiers.length > 0 && <p className="text-gray-500">{l.modifiers.map((m) => m.name).join(', ')}</p>}
              </div>
              <div className="flex items-center gap-3">
                <button className="rounded-full bg-gray-100 p-3" aria-label="Menos" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity - 1 } : x)).filter((x) => x.quantity > 0))}>
                  {l.quantity === 1 ? <Trash2 className="h-6 w-6 text-red-500" /> : <Minus className="h-6 w-6" />}
                </button>
                <span className="w-8 text-center text-2xl font-bold">{l.quantity}</span>
                <button className="rounded-full bg-gray-100 p-3" aria-label="Más" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x)))}><Plus className="h-6 w-6" /></button>
              </div>
              <p className="w-28 text-right text-xl font-semibold">{formatMXN(unit(l) * l.quantity)}</p>
            </div>
          ))}
          <label className="block">
            <span className="mb-2 block text-xl font-semibold text-gray-700">¿A nombre de quién?</span>
            <input className="input-light py-4 text-2xl" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
          </label>
        </div>
      )}

      {step === 'listo' && done && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
          <CheckCircle2 className="h-24 w-24 text-emerald-500" />
          <p className="text-3xl text-gray-600">¡Gracias, {done.customer_name}!</p>
          <p className="text-2xl text-gray-500">Tu número de orden es</p>
          <p className="text-9xl font-extrabold text-brand">{done.folio}</p>
          <p className="text-3xl font-semibold text-gray-900">Pasa a pagar a caja: {formatMXN(done.total)}</p>
          <button onClick={reset} className="btn-brand mt-6 px-10 py-4 text-xl">Nueva orden</button>
        </div>
      )}

      {(step === 'menu' || step === 'revisar') && (
        <footer className="flex items-center gap-4 border-t border-gray-200 bg-white px-6 py-4">
          <p className="text-xl text-gray-600">{count} {count === 1 ? 'producto' : 'productos'} · <b className="text-2xl text-gray-900">{formatMXN(total)}</b></p>
          {step === 'menu' ? (
            <button disabled={!count} onClick={() => setStep('revisar')} className="btn-brand ml-auto px-10 py-4 text-xl">Revisar pedido</button>
          ) : (
            <button disabled={!count || !name.trim() || sending} onClick={send} className="btn-brand ml-auto px-10 py-4 text-xl">
              {sending && <Loader2 className="h-6 w-6 animate-spin" />} Confirmar pedido
            </button>
          )}
        </footer>
      )}

      {picking && (
        <ModifierModal item={picking} groups={groupsOf(picking)} onClose={() => setPicking(null)}
          onAdd={(sel) => { setCart((c) => [...c, { ...sel, key: lineKey++ }]); setPicking(null); }} />
      )}
    </div>
  );
}
