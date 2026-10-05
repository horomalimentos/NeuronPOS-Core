import { Building2, LayoutDashboard, LogOut, Store, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { applyBranding } from '../lib/branding';
import { ROLE_LABEL } from '../lib/format';
import { session } from '../lib/session';
import type { Me } from '../lib/types';
import { canManage, type AdminContext } from './context';

export default function AdminLayout() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const hasToken = Boolean(session.getToken('restaurant'));

  const reload = useCallback(() => {
    api<Me>('/me')
      .then((m) => {
        setMe(m);
        applyBranding(m.restaurant.primary_color, m.restaurant.secondary_color);
        document.title = `${m.restaurant.name} · NeuronPOS`;
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => { if (hasToken) reload(); }, [hasToken, reload]);

  if (!hasToken) return <Navigate to="/admin/login" replace />;
  if (error) return <div className="mx-auto max-w-md p-8"><Alert>{error}</Alert></div>;
  if (!me) return <Spinner />;

  const logout = () => {
    session.setToken('restaurant', null);
    navigate('/admin/login', { replace: true });
  };

  const nav = [
    { to: '/admin', label: 'Inicio', icon: LayoutDashboard, end: true, show: true },
    { to: '/admin/sucursales', label: 'Sucursales', icon: Building2, end: false, show: canManage(me.user.role) },
    { to: '/admin/usuarios', label: 'Usuarios', icon: Users, end: false, show: canManage(me.user.role) },
  ].filter((n) => n.show);

  const ctx: AdminContext = { me, reload };
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-gray-800 bg-gray-950/90 backdrop-blur">
        <div className="h-0.5 bg-brand" />
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-white">
            {me.restaurant.logo_url
              ? <img src={me.restaurant.logo_url} alt="" className="h-7 w-7 rounded object-contain" />
              : <Store className="h-6 w-6 text-brand" />}
            {me.restaurant.name}
          </div>
          <nav className="flex flex-1 gap-1">
            {nav.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end}
                className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition
                  ${isActive ? 'bg-brand/15 text-white' : 'text-gray-400 hover:text-white'}`}>
                <Icon className="h-4 w-4" /> {label}
              </NavLink>
            ))}
          </nav>
          <div className="text-right text-xs leading-tight text-gray-400">
            <div className="text-sm text-gray-200">{me.user.name}</div>
            {ROLE_LABEL[me.user.role]}
          </div>
          <button onClick={logout} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white" aria-label="Cerrar sesión">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        {me.restaurant.access_error && <div className="mb-6"><Alert kind="warning">{me.restaurant.access_error.error}</Alert></div>}
        <Outlet context={ctx} />
      </main>
    </div>
  );
}
