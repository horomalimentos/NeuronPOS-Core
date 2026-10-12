import { Bike, ChefHat, Clock, CreditCard, PackageCheck, ShoppingBag, Store } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatMXN } from '../lib/format';
import { cartStore, cartTotal, ordersStore, useStore } from './customer';
import { nayoPath } from './nayoUrl';

type Status = 'pago_pendiente' | 'nuevo' | 'aceptado' | 'listo' | 'en_camino' | 'entregado' | 'rechazado' | 'cancelado';
interface Live { token: string; status: Status; status_label: string; restaurant: { name: string; logo_url: string | null } }

const POLL_MS = 20000;
/** Solo se siguen los pedidos de las ultimas horas (los viejos ya no estan en curso). */
const RECENT_MS = 12 * 60 * 60 * 1000;
const DONE: Status[] = ['entregado', 'rechazado', 'cancelado'];
const ICON: Record<Status, typeof Clock> = {
  pago_pendiente: CreditCard, nuevo: Clock, aceptado: ChefHat, listo: PackageCheck, en_camino: Bike,
  entregado: PackageCheck, rechazado: Clock, cancelado: Clock,
};

/**
 * Globo flotante de Nayo, como en las apps de reparto: mientras tienes un
 * pedido en curso se queda abajo en la pantalla con su estado y te lleva al
 * seguimiento. Si tienes un carrito sin terminar (de otro restaurante que el
 * que estas viendo) tambien aparece, para volver a el.
 */
export default function ActiveOrderBubble({ branchId, raised = false }: { branchId?: string; raised?: boolean }) {
  const recent = useStore(ordersStore);
  const cart = useStore(cartStore);
  const [live, setLive] = useState<Live[]>([]);

  const tokens = recent.filter((o) => Date.now() - new Date(o.at).getTime() < RECENT_MS).map((o) => o.token).join(',');
  const load = useCallback(() => {
    if (!tokens) { setLive([]); return; }
    Promise.all(tokens.split(',').map((t) => api<{ order: Live }>(`/marketplace/orders/${t}`, { noRedirect: true })
      .then((r) => r.order).catch(() => null)))
      .then((all) => setLive(all.filter((o): o is Live => Boolean(o) && !DONE.includes((o as Live).status))));
  }, [tokens]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const items = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const showCart = items > 0 && cart.branch_id && cart.branch_id !== branchId;
  if (!live.length && !showCart) return null;

  return (
    <div className={`pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] ${raised ? 'bottom-[4.5rem]' : 'bottom-0'}`}>
      {showCart && (
        <Link to={nayoPath(`/r/${cart.branch_id}`)}
          className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-gray-800/95 py-2 pl-2 pr-4 text-sm text-white shadow-2xl ring-1 ring-white/10 backdrop-blur hover:bg-gray-700">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-brand-contrast"><ShoppingBag className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1 truncate">Tu carrito · <span className="font-semibold">{cart.restaurant_name}</span></span>
          <span className="font-semibold">{items} · {formatMXN(cartTotal(cart))}</span>
        </Link>
      )}
      {live.map((o) => {
        const Icon = ICON[o.status];
        return (
          <Link key={o.token} to={nayoPath(`/pedido/${o.token}`)}
            className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-white py-2 pl-2 pr-4 text-gray-900 shadow-2xl shadow-black/60 transition hover:bg-gray-100">
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
              <span className="absolute -right-0.5 -top-0.5 z-10 flex h-3 w-3"><span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400" /><span className="relative h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-white" /></span>
              {o.restaurant.logo_url
                ? <img src={o.restaurant.logo_url} alt="" className="relative h-11 w-11 rounded-full object-cover ring-2 ring-gray-200" />
                : <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-gray-950 text-brand"><Store className="h-5 w-5" /></span>}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-xs font-medium text-gray-500">{o.restaurant.name}</span>
              <span className="flex items-center gap-1.5 truncate font-bold"><Icon className="h-4 w-4 shrink-0" /> {o.status_label}</span>
            </span>
            <span className="rounded-full bg-brand px-3 py-1 text-xs font-bold text-brand-contrast">Ver</span>
          </Link>
        );
      })}
    </div>
  );
}
