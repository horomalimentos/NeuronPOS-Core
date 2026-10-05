import { AlertCircle, Image as ImageIcon, Loader2, Minus, Plus, Search, ShoppingBag, Store, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { cartStore, useCart } from './cart';
import { hasModule, useSiteCtx } from './context';
import { openLabel } from './hours';
import ItemModal from './ItemModal';
import { pickBranch } from './portalLib';
import type { PortalConfig, PortalItem, PortalMenu } from './types';

/**
 * Menu en linea: sucursal, categorias, productos con modificadores y el
 * carrito (estimado). Inspirado en el portal web de NeuronPOS.
 */
export default function OrderPage() {
  const { site } = useSiteCtx();
  const navigate = useNavigate();
  const { cart, count, subtotal } = useCart();
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [menu, setMenu] = useState<PortalMenu | null>(null);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<PortalItem | null>(null);

  useEffect(() => {
    if (!hasModule(site, 'portal')) return;
    portalApi<PortalConfig>('/portal/config', { noRedirect: true })
      .then((c) => {
        setConfig(c);
        const b = pickBranch(c, cartStore.get().branch_id);
        if (b && b !== cartStore.get().branch_id) cartStore.setBranch(b);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [site]);

  const branchId = cart.branch_id;
  useEffect(() => {
    if (!config || !branchId) return;
    setMenu(null);
    portalApi<PortalMenu>(`/portal/menu?branch_id=${branchId}`, { noRedirect: true })
      .then(setMenu)
      .catch((e) => setError(errorMessage(e)));
  }, [config, branchId]);

  const groups = useMemo(() => new Map((menu?.modifier_groups || []).map((g) => [g.id, g])), [menu]);
  const items = useMemo(() => {
    if (!menu) return [];
    const q = search.trim().toLowerCase();
    return menu.items.filter((i) => (q ? `${i.name} ${i.description || ''}`.toLowerCase().includes(q) : !category || i.category_id === category));
  }, [menu, category, search]);

  if (!hasModule(site, 'portal')) {
    return <p className="px-6 py-24 text-center text-gray-500">Este restaurante no tiene pedidos en línea.</p>;
  }
  if (error && !config) return <p className="px-6 py-24 text-center text-gray-500">{error}</p>;
  if (!config) return <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  const branch = config.branches.find((b) => b.id === branchId) || null;
  const canOrder = config.ordering_available && Boolean(branch?.accepts_orders);
  const minOrder = Number(config.settings.min_order || 0);

  function clickItem(it: PortalItem) {
    if (!it.available || !canOrder) return;
    const itemGroups = it.modifier_group_ids.map((id) => groups.get(id)).filter((g) => g !== undefined);
    if (itemGroups.length) setPicked(it);
    else cartStore.add({ item_id: it.id, name: it.name, image_url: it.image_url, unit_price: Number(it.price), quantity: 1, modifier_ids: [], modifier_names: [], notes: '' });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {!config.ordering_available && (
        <Notice>Por ahora no estamos recibiendo pedidos en línea. Puedes ver el menú.</Notice>
      )}

      {/* Sucursal */}
      {config.branches.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <Store className="h-5 w-5 text-brand" />
          {config.branches.length > 1 ? (
            <select className="input-light w-auto py-2 font-semibold" value={branchId || ''} aria-label="Sucursal"
              onChange={(e) => cartStore.setBranch(e.target.value)}>
              {config.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : <span className="font-semibold">{branch?.name}</span>}
          {branch && (
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${branch.open_now ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'}`}>
              {openLabel(branch)}
            </span>
          )}
        </div>
      )}
      {branch && config.ordering_available && !branch.accepts_orders && <Notice>Esta sucursal no recibe pedidos en línea.</Notice>}
      {branch && canOrder && !branch.open_now && (
        <Notice>{branch.name} está cerrada en este momento: puedes armar tu pedido y enviarlo cuando abra.</Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input className="input-light rounded-full pl-10" placeholder="Buscar en el menú" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {menu && (
            <div className="sticky top-[4.25rem] z-30 -mx-4 mb-4 flex gap-2 overflow-x-auto bg-stone-50/95 px-4 py-2 backdrop-blur">
              {[{ id: '', name: 'Todo' }, ...menu.categories].map((c) => (
                <button key={c.id} onClick={() => { setCategory(c.id); setSearch(''); }}
                  className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition
                    ${category === c.id && !search ? 'bg-brand text-brand-contrast' : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-gray-300'}`}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {!menu ? <div className="flex justify-center py-16 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div> : (
            <>
              {items.length === 0 && <p className="py-12 text-center text-gray-500">No hay productos.</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                {items.map((it) => (
                  <button key={it.id} onClick={() => clickItem(it)} disabled={!it.available || !canOrder}
                    className={`card-light flex min-h-[7rem] overflow-hidden text-left transition ${it.available && canOrder ? 'hover:border-brand/50 hover:shadow-md' : 'cursor-default'} ${it.available ? '' : 'opacity-60'}`}>
                    <div className="flex min-w-0 flex-1 flex-col p-4">
                      <span className="font-semibold text-gray-900">{it.name}</span>
                      {it.description && <span className="mt-1 line-clamp-2 text-sm text-gray-500">{it.description}</span>}
                      <span className="mt-auto flex items-center justify-between pt-2">
                        <span className="font-bold text-gray-900">{formatMXN(it.price)}</span>
                        {!it.available ? <span className="text-xs font-semibold text-red-600">Agotado</span>
                          : canOrder && <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-brand-contrast"><Plus className="h-4 w-4" /></span>}
                      </span>
                    </div>
                    <div className="relative w-28 flex-shrink-0 bg-gray-100">
                      {it.image_url
                        ? <img src={it.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                        : <ImageIcon className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-gray-300" />}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Carrito (escritorio) */}
        <aside className="hidden lg:block">
          <div className="card-light sticky top-24 flex max-h-[calc(100vh-8rem)] flex-col">
            <h2 className="flex items-center gap-2 border-b border-gray-100 p-4 font-bold"><ShoppingBag className="h-5 w-5 text-brand" /> Tu pedido</h2>
            <CartLines />
            <div className="border-t border-gray-100 p-4">
              <div className="flex justify-between font-semibold"><span>Subtotal</span><span>{formatMXN(subtotal)}</span></div>
              {minOrder > 0 && subtotal < minOrder && count > 0 && (
                <p className="mt-1 text-xs text-amber-700">Pedido mínimo {formatMXN(minOrder)}</p>
              )}
              <button className="btn-brand mt-3 w-full py-3" disabled={!count || !canOrder} onClick={() => navigate('/pedir/checkout')}>
                Continuar
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* Barra del carrito (celular) */}
      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white p-3 lg:hidden">
          <Link to="/pedir/checkout" className="btn-brand w-full justify-between py-3.5 text-base">
            <span className="rounded-full bg-black/15 px-2.5 py-0.5 text-sm">{count}</span>
            Ver mi pedido
            <span>{formatMXN(subtotal)}</span>
          </Link>
        </div>
      )}

      {picked && (
        <ItemModal item={picked} onClose={() => setPicked(null)}
          groups={picked.modifier_group_ids.map((id) => groups.get(id)).filter((g) => g !== undefined)}
          onAdd={(line) => { cartStore.add(line); setPicked(null); }} />
      )}
    </div>
  );
}

export function Notice({ children, kind = 'warning' }: { children: ReactNode; kind?: 'warning' | 'error' }) {
  return (
    <div className={`mb-4 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm
      ${kind === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`} role={kind === 'error' ? 'alert' : 'status'}>
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" /> <div>{children}</div>
    </div>
  );
}

/** Lineas del carrito con cantidad editable. */
export function CartLines({ readOnly = false }: { readOnly?: boolean }) {
  const { cart } = useCart();
  if (!cart.lines.length) return <p className="p-6 text-center text-sm text-gray-500">Tu pedido está vacío.</p>;
  return (
    <ul className="flex-1 divide-y divide-gray-100 overflow-y-auto">
      {cart.lines.map((l) => (
        <li key={l.key} className="flex gap-3 px-4 py-3 text-sm">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900">{l.name}</div>
            {l.modifier_names.length > 0 && <div className="text-xs text-gray-500">{l.modifier_names.join(', ')}</div>}
            {l.notes && <div className="text-xs italic text-gray-500">“{l.notes}”</div>}
            {!readOnly && (
              <div className="mt-1.5 flex items-center gap-1">
                <button className="rounded-full border border-gray-300 p-1 hover:bg-gray-50" onClick={() => cartStore.setQuantity(l.key, l.quantity - 1)} aria-label="Menos"><Minus className="h-3 w-3" /></button>
                <span className="w-6 text-center font-semibold">{l.quantity}</span>
                <button className="rounded-full border border-gray-300 p-1 hover:bg-gray-50" onClick={() => cartStore.setQuantity(l.key, l.quantity + 1)} aria-label="Más"><Plus className="h-3 w-3" /></button>
                <button className="ml-2 rounded-full p-1 text-gray-400 hover:text-red-600" onClick={() => cartStore.remove(l.key)} aria-label="Quitar"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            )}
          </div>
          <span className="whitespace-nowrap font-medium">{readOnly && `${l.quantity} × `}{formatMXN(l.unit_price * (readOnly ? 1 : l.quantity))}</span>
        </li>
      ))}
    </ul>
  );
}
