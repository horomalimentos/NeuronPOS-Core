import { BrainCircuit, ClipboardList, Loader2, ShoppingBag, Store, User } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import HomePage from '../home/HomePage';
import { ApiError, portalApi } from '../lib/api';
import { applyBranding } from '../lib/branding';
import { session } from '../lib/session';
import type { PublicSite } from '../lib/types';
import { useCart } from './cart';
import { hasModule, setSeo, type SiteContext } from './context';
import type { Customer } from './types';

/**
 * Marco del sitio publico y del portal de clientes: carga /api/public/site
 * del restaurante resuelto por dominio, aplica su marca y muestra el
 * encabezado (logo, menu, cuenta, carrito) y el pie.
 */
export default function SiteLayout() {
  const location = useLocation();
  const [site, setSite] = useState<PublicSite | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'not_found' | 'error'>('loading');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const { count } = useCart();

  useEffect(() => {
    let cancelled = false;
    portalApi<PublicSite>('/public/site', { noRedirect: true })
      .then((s) => {
        if (cancelled) return;
        setSite(s);
        setState('ok');
        applyBranding(s.restaurant.primary_color, s.restaurant.secondary_color);
        setSeo(s.seo.title, s.seo.description, s.restaurant.logo_url);
      })
      .catch((err) => { if (!cancelled) setState(err instanceof ApiError && err.status === 404 ? 'not_found' : 'error'); });
    return () => { cancelled = true; };
  }, []);

  const portal = site ? hasModule(site, 'portal') : false;
  const refreshCustomer = useCallback(() => {
    if (!portal || !session.getToken('customer')) { setCustomer(null); return; }
    portalApi<{ customer: Customer }>('/portal/me', { noRedirect: true })
      .then((r) => setCustomer(r.customer))
      .catch(() => { session.setToken('customer', null); setCustomer(null); });
  }, [portal]);
  useEffect(refreshCustomer, [refreshCustomer]);

  const logout = useCallback(() => {
    session.setToken('customer', null);
    setCustomer(null);
  }, []);

  if (state === 'loading') {
    return <div className="site-light flex items-center justify-center text-gray-500"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (state === 'not_found' || !site) {
    return location.pathname === '/' && state === 'not_found' ? <HomePage /> : (
      <div className="site-light flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Store className="h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold">{state === 'not_found' ? 'Restaurante no encontrado' : 'No se pudo conectar con el servidor'}</h1>
        <p className="text-sm text-gray-500">Revisa la dirección o intenta de nuevo en unos minutos.</p>
      </div>
    );
  }

  const r = site.restaurant;
  const ctx: SiteContext = { site, customer, refreshCustomer, logout };
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-1.5 text-sm font-medium transition ${isActive ? 'bg-brand/10 text-brand' : 'text-gray-700 hover:text-brand'}`;

  return (
    <div className="site-light flex flex-col">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex min-w-0 items-center gap-2.5">
            {r.logo_url
              ? <img src={r.logo_url} alt={r.name} className="h-10 w-auto max-w-[9rem] object-contain" />
              : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-brand-contrast"><Store className="h-5 w-5" /></span>}
            <span className="truncate text-lg font-bold text-gray-900">{r.name}</span>
          </Link>
          {r.available && (
            <nav className="ml-auto flex items-center gap-1">
              {portal && <NavLink to="/pedir" className={navClass}>Menú</NavLink>}
              {portal && (
                <NavLink to="/cuenta/pedidos" className={navClass} aria-label="Mis pedidos">
                  <span className="hidden sm:inline">Mis pedidos</span><ClipboardList className="h-5 w-5 sm:hidden" />
                </NavLink>
              )}
              {portal && (
                <NavLink to={customer ? '/cuenta' : '/cuenta/entrar'} className={navClass} aria-label="Mi cuenta">
                  <span className="flex items-center gap-1.5"><User className="h-5 w-5" /><span className="hidden max-w-[8rem] truncate md:inline">{customer ? customer.name.split(' ')[0] : 'Entrar'}</span></span>
                </NavLink>
              )}
              {site.ordering && (
                <Link to="/pedir/checkout" className="relative ml-1 rounded-full bg-brand p-2.5 text-brand-contrast" aria-label={`Carrito (${count})`}>
                  <ShoppingBag className="h-5 w-5" />
                  {count > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-gray-900 px-1 text-xs font-bold text-white">{count}</span>
                  )}
                </Link>
              )}
            </nav>
          )}
        </div>
        <div className="h-1 bg-brand" />
      </header>

      <main className="flex-1">
        {r.available ? <Outlet context={ctx} /> : (
          <div className="mx-auto max-w-md px-6 py-24 text-center">
            <h1 className="text-2xl font-bold">{r.name}</h1>
            <p className="mt-3 text-gray-500">Este sitio no está disponible por el momento.</p>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-gray-500">
          <span>© {new Date().getFullYear()} {r.name}</span>
          <span className="flex items-center gap-4">
            <Link to="/admin/login" className="hover:text-gray-800">Acceso del personal</Link>
            <span className="inline-flex items-center gap-1 text-gray-400"><BrainCircuit className="h-4 w-4" /> NeuronPOS</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
