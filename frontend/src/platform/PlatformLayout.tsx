import { Building2, LogOut, Package, Receipt, Settings, Store, Truck } from 'lucide-react';
import InstallApp from '../components/InstallApp';
import { NeuronLogo } from '../components/NeuronLogo';
import { PushBell, PushFab } from '../components/PushBell';
import { useEffect } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { resetBranding } from '../lib/branding';
import { disablePush } from '../lib/push';
import { session } from '../lib/session';

const NAV = [
  { to: '/panel', label: 'Restaurantes', icon: Building2, end: true },
  { to: '/panel/modulos', label: 'Módulos y precios', icon: Package, end: false },
  { to: '/panel/cobros', label: 'Cobros', icon: Receipt, end: false },
  { to: '/panel/flota', label: 'Flota', icon: Truck, end: false },
  { to: '/panel/delivery', label: 'Nayo', icon: Store, end: false },
  { to: '/panel/ajustes', label: 'Ajustes', icon: Settings, end: false },
];

const PANEL_PUSH = { realm: 'platform' } as const;

/** Panel de la plataforma; tambien es la app instalable Panel (panel.webmanifest). */
export default function PlatformLayout() {
  const navigate = useNavigate();
  useEffect(() => resetBranding(), []);
  if (!session.getToken('platform')) return <Navigate to="/panel/login" replace />;

  const logout = async () => {
    // Este navegador deja de recibir los avisos del Panel.
    await disablePush(PANEL_PUSH).catch(() => {});
    session.setToken('platform', null);
    navigate('/panel/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-gray-800 bg-gray-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="mr-auto flex items-center gap-2 font-semibold text-white md:mr-0">
            <NeuronLogo className="h-6 w-auto" /> <span className="text-sm font-medium text-gray-400">Panel</span>
          </div>
          {/* Celular: el menu va en su propio renglon (se desliza de lado). */}
          <nav className="order-last flex w-full gap-1 overflow-x-auto md:order-none md:w-auto md:flex-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => `flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition
                  ${isActive ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <Icon className="h-4 w-4" /> {label}
              </NavLink>
            ))}
          </nav>
          <InstallApp label="Instalar app" />
          <PushBell target={PANEL_PUSH} />
          <button onClick={() => void logout()} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white">
            <LogOut className="h-4 w-4" /> Salir
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
      <PushFab target={PANEL_PUSH} text="Activa avisos de registros nuevos" className="bottom-6 right-4" />
    </div>
  );
}
