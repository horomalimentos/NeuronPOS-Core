import { BarChart3, BellRing, Clock, LogOut, Settings, UtensilsCrossed } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import InstallApp from '../components/InstallApp';
import { NayoMark } from '../components/NayoLogo';
import { PushBell, PushFab } from '../components/PushBell';
import { useNayoFavicon } from '../components/useNayoFavicon';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { disablePush } from '../lib/push';
import { session } from '../lib/session';
import type { Me } from '../lib/types';
import { setSessionCapabilities } from '../pos/lib';
import { canManage, meHas, type AdminContext } from '../restaurant/context';

const NAYO_RESTAURANTE = { realm: 'nayo', app: 'restaurante' } as const;

/**
 * Nayo Partner: app instalable del restaurante (dueno o gerente) para
 * administrar lo suyo en Nayo desde el celular: numeros y graficas, pedidos,
 * menu, horario y ficha. Reusa las pantallas del panel del restaurante con el
 * mismo contexto (useAdmin), asi que se comportan igual en las dos partes.
 * El cajero solo ve los pedidos.
 */
export default function PartnerLayout() {
  useNayoFavicon();
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const hasToken = Boolean(session.getToken('restaurant'));

  const reload = useCallback(() => {
    api<Me>('/me').then((m) => {
      setSessionCapabilities(m.capabilities);
      setMe(m);
      document.title = `${m.restaurant.name} · Nayo Partner`;
    }).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => { resetBranding(); if (hasToken) reload(); }, [hasToken, reload]);

  if (!hasToken) return <Navigate to="/partner/entrar" replace />;
  if (error) return <div className="mx-auto max-w-md p-8"><Alert>{error}</Alert></div>;
  if (!me) return <Spinner />;

  const logout = async () => {
    await disablePush(NAYO_RESTAURANTE).catch(() => {});
    session.setToken('restaurant', null);
    navigate('/partner/entrar', { replace: true });
  };

  const here = location.pathname.replace(/\/$/, '');
  const manager = canManage(me.user.role);
  const ctx: AdminContext = { me, reload };

  if (me.restaurant.access_error || !meHas(me, 'marketplace') || !['admin', 'gerente', 'cajero'].includes(me.user.role)) {
    return (
      <Shell me={me} onLogout={logout}>
        <Alert kind="warning">
          {me.restaurant.access_error?.error
            || (!meHas(me, 'marketplace') ? 'Tu restaurante todavía no está en Nayo.' : 'Tu usuario no tiene acceso a Nayo Partner.')}
        </Alert>
      </Shell>
    );
  }
  // La pantalla de pedidos ocupa toda la pantalla (tiene su propio encabezado y su "Salir").
  if (here === '/partner/pedidos') return <Outlet context={ctx} />;
  if (!manager) return <Navigate to="/partner/pedidos" replace />;

  const tabs = [
    { to: '/partner', label: 'Inicio', icon: BarChart3, end: true },
    { to: '/partner/pedidos', label: 'Pedidos', icon: BellRing, end: true },
    { to: '/partner/menu', label: 'Menú', icon: UtensilsCrossed, end: false },
    { to: '/partner/horario', label: 'Horario', icon: Clock, end: false },
    { to: '/partner/ajustes', label: 'Ajustes', icon: Settings, end: false },
  ];
  return (
    <Shell me={me} onLogout={logout} tabs={tabs}>
      <Outlet context={ctx} />
    </Shell>
  );
}

type Tab = { to: string; label: string; icon: typeof BarChart3; end: boolean };

function Shell({ me, onLogout, tabs = [], children }: {
  me: Me; onLogout: () => void; tabs?: Tab[]; children: ReactNode;
}) {
  const tabClass = ({ isActive }: { isActive: boolean }) => `flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[11px] font-medium transition
    sm:flex-none sm:flex-row sm:gap-2 sm:px-3 sm:text-sm ${isActive ? 'text-brand sm:bg-brand/15 sm:text-white' : 'text-gray-400 hover:text-white'}`;
  return (
    <div className="min-h-screen pb-24 sm:pb-0">
      <header className="sticky top-0 z-40 border-b border-gray-800 bg-gray-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <NayoMark className="h-7 w-7 shrink-0" />
          <div className="mr-auto min-w-0 leading-tight">
            <p className="truncate font-semibold text-white">{me.restaurant.name}</p>
            <p className="text-xs text-gray-400">Nayo Partner</p>
          </div>
          <InstallApp label="Instalar" />
          <PushBell target={NAYO_RESTAURANTE} className="[&_svg]:h-5 [&_svg]:w-5" />
          <button type="button" onClick={onLogout} className="p-1 text-gray-400 hover:text-white" aria-label="Cerrar sesión" title="Cerrar sesión">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
        {tabs.length > 0 && (
          <nav className="mx-auto hidden max-w-5xl gap-1 px-4 pb-2 sm:flex">
            {tabs.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={tabClass}><Icon className="h-4 w-4" /> {label}</NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      {tabs.length > 0 && (
        // Celular: pestanas abajo, como las apps de socios de Uber Eats o DiDi.
        <nav className="fixed inset-x-0 bottom-0 z-40 flex gap-1 border-t border-gray-800 bg-gray-950/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur sm:hidden">
          {tabs.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={tabClass}><Icon className="h-5 w-5" /> {label}</NavLink>
          ))}
        </nav>
      )}
      <PushFab target={NAYO_RESTAURANTE} text="Activa avisos de pedidos nuevos" className="bottom-24 right-4 sm:bottom-6" />
    </div>
  );
}
