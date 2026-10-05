import {
  Award, Bike, Building2, ChefHat, Clock, CreditCard, Globe, Contact, LayoutDashboard, LayoutGrid, LogOut, Monitor, Receipt,
  Settings, ShoppingBag, Store, Trophy, Truck, UtensilsCrossed, Users, Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { applyBranding } from '../lib/branding';
import { ROLE_LABEL, formatDay, formatMXN } from '../lib/format';
import { session } from '../lib/session';
import { posCan } from '../pos/lib';
import type { Me } from '../lib/types';
import { canManage, type AdminContext } from './context';

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
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

  const role = me.user.role;
  // Suspendido o prueba vencida: solo "Mi suscripcion" (para pagar).
  const blocked = Boolean(me.restaurant.access_error);
  const SUBSCRIPTION = '/admin/suscripcion';
  const onSubscription = location.pathname.replace(/\/$/, '') === SUBSCRIPTION;
  if (blocked && canManage(role) && !onSubscription) return <Navigate to={SUBSCRIPTION} replace />;
  const has = (code: string) => !blocked && Boolean(me.modules.find((m) => m.code === code)?.enabled);
  const hasPos = has('pos');
  const nav = [
    { to: '/admin', label: 'Inicio', icon: LayoutDashboard, end: true, show: !blocked },
    { to: '/admin/pos', label: 'Vender', icon: Monitor, end: true, show: hasPos && posCan.orders(role) },
    { to: '/admin/cocina', label: 'Cocina', icon: ChefHat, end: false, show: hasPos && posCan.kitchen(role) },
    { to: '/admin/caja', label: 'Caja', icon: Wallet, end: false, show: hasPos && posCan.cashier(role) },
    { to: '/admin/menu', label: 'Menú', icon: UtensilsCrossed, end: false, show: hasPos && posCan.manage(role) },
    { to: '/admin/mesas', label: 'Mesas', icon: LayoutGrid, end: false, show: hasPos && posCan.manage(role) },
    { to: '/admin/pos/ajustes', label: 'Ajustes', icon: Settings, end: false, show: hasPos && posCan.manage(role) },
    { to: '/admin/reparto', label: 'Reparto', icon: Bike, end: false, show: has('domicilios') && posCan.cashier(role) },
    { to: '/repartidor', label: 'Mis entregas', icon: Bike, end: false, show: has('domicilios') && role === 'repartidor' },
    { to: '/admin/domicilios', label: 'Domicilios', icon: Truck, end: false, show: has('domicilios') && canManage(role) },
    { to: '/admin/rh', label: 'RH', icon: Contact, end: false, show: has('rh') && canManage(role) },
    { to: '/admin/checador', label: 'Checador', icon: Clock, end: false, show: has('rh') },
    { to: '/admin/mi-nomina', label: 'Mi nómina', icon: Receipt, end: false, show: has('rh') },
    { to: '/admin/empleado-del-mes', label: 'Empleado del mes', icon: Award, end: false, show: has('empleado_mes') && canManage(role) },
    { to: '/admin/muro', label: 'Muro', icon: Trophy, end: false, show: has('empleado_mes') },
    { to: '/admin/sitio', label: 'Sitio web', icon: Globe, end: false, show: has('landing') && canManage(role) },
    { to: '/admin/pedidos-en-linea', label: 'Pedidos en línea', icon: ShoppingBag, end: false, show: has('portal') && canManage(role) },
    { to: '/admin/sucursales', label: 'Sucursales', icon: Building2, end: false, show: !blocked && canManage(role) },
    { to: '/admin/usuarios', label: 'Usuarios', icon: Users, end: false, show: !blocked && canManage(role) },
    { to: SUBSCRIPTION, label: 'Mi suscripción', icon: CreditCard, end: false, show: canManage(role) },
  ].filter((n) => n.show);
  // La pantalla de venta y la de cocina usan todo el ancho (tabletas).
  const wide = ['/admin/pos', '/admin/cocina'].includes(location.pathname.replace(/\/$/, ''));

  const ctx: AdminContext = { me, reload };
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-gray-800 bg-gray-950/90 backdrop-blur">
        <div className="h-0.5 bg-brand" />
        <div className={`mx-auto flex ${wide ? 'max-w-none' : 'max-w-6xl'} flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3`}>
          <div className="flex items-center gap-2 font-semibold text-white">
            {me.restaurant.logo_url
              ? <img src={me.restaurant.logo_url} alt="" className="h-7 w-7 rounded object-contain" />
              : <Store className="h-6 w-6 text-brand" />}
            {me.restaurant.name}
          </div>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {nav.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end}
                className={({ isActive }) => `flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition
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
      <main className={wide ? 'px-3 py-4 sm:px-4' : 'mx-auto max-w-6xl px-4 py-8'}>
        {blocked && !onSubscription && (
          <div className="mb-6">
            <Alert kind="warning">
              {me.restaurant.access_error?.error}
              {!canManage(role) && ' Pide a un administrador que entre a "Mi suscripción" para pagar.'}
            </Alert>
          </div>
        )}
        {!blocked && <BillingBanner me={me} show={canManage(role) && !onSubscription} />}
        {blocked && !canManage(role) ? null : <Outlet context={ctx} />}
      </main>
    </div>
  );
}

/** Aviso de pago pendiente o vencido (admin y gerente). */
function BillingBanner({ me, show }: { me: Me; show: boolean }) {
  const inv = me.billing?.next_invoice;
  if (!show || !inv) return null;
  const overdue = me.billing?.overdue;
  return (
    <div className="mb-6">
      <Alert kind={overdue ? 'error' : 'warning'}>
        {overdue
          ? <>Tu pago de {formatMXN(inv.amount_mxn)} está vencido{inv.suspends_on && <>; el servicio se suspende el {formatDay(inv.suspends_on)}</>}.</>
          : <>Tienes un pago pendiente de {formatMXN(inv.amount_mxn)} con fecha límite {formatDay(inv.due_date)}.</>}
        {' '}<Link to="/admin/suscripcion" className="font-semibold underline">Pagar ahora</Link>
      </Alert>
    </div>
  );
}
