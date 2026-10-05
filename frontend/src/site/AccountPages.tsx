import { ChevronRight, ClipboardList, Loader2, LogOut, MapPin, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage, portalApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { session } from '../lib/session';
import { recentOrders } from './cart';
import { hasModule, useSiteCtx } from './context';
import { Notice } from './OrderPage';
import { STATUS_STYLE, formatDateTimeShort } from './portalLib';
import type { Address, Customer, CustomerOrder } from './types';

/** Solo rutas internas para ?volver= (evita redirecciones abiertas). */
const safeNext = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') ? v : '/cuenta');

function AuthBox({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <div className="card-light p-6 sm:p-8">
        <h1 className="mb-6 text-center text-2xl font-bold">{title}</h1>
        {children}
      </div>
      <p className="mt-4 text-center text-sm text-gray-600">{footer}</p>
    </div>
  );
}

function PortalOnly({ children }: { children: ReactNode }) {
  const { site } = useSiteCtx();
  if (!hasModule(site, 'portal')) return <p className="px-6 py-24 text-center text-gray-500">Este restaurante no tiene portal de clientes.</p>;
  return <>{children}</>;
}

export function LoginPage() {
  const { refreshCustomer } = useSiteCtx();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await portalApi<{ token: string }>('/portal/auth/login', { method: 'POST', body: { email, password }, noRedirect: true });
      session.setToken('customer', r.token);
      refreshCustomer();
      navigate(safeNext(params.get('volver')), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <PortalOnly>
      <AuthBox title="Inicia sesión" footer={<>¿No tienes cuenta? <Link className="font-semibold text-brand" to={`/cuenta/registro${params.get('volver') ? `?volver=${encodeURIComponent(params.get('volver')!)}` : ''}`}>Regístrate</Link></>}>
        <form onSubmit={submit} className="space-y-4">
          {error && <Notice kind="error">{error}</Notice>}
          <label className="block"><span className="label-light">Correo</span>
            <input className="input-light" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block"><span className="label-light">Contraseña</span>
            <input className="input-light" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn-brand w-full py-3" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Entrar</button>
        </form>
      </AuthBox>
    </PortalOnly>
  );
}

export function RegisterPage() {
  const { refreshCustomer } = useSiteCtx();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await portalApi<{ token: string }>('/portal/auth/register', { method: 'POST', body: form, noRedirect: true });
      session.setToken('customer', r.token);
      refreshCustomer();
      navigate(safeNext(params.get('volver')), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <PortalOnly>
      <AuthBox title="Crea tu cuenta" footer={<>¿Ya tienes cuenta? <Link className="font-semibold text-brand" to="/cuenta/entrar">Inicia sesión</Link></>}>
        <form onSubmit={submit} className="space-y-4">
          {error && <Notice kind="error">{error}</Notice>}
          <label className="block"><span className="label-light">Nombre</span>
            <input className="input-light" required maxLength={120} autoComplete="name" value={form.name} onChange={set('name')} />
          </label>
          <label className="block"><span className="label-light">Correo</span>
            <input className="input-light" type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
          </label>
          <label className="block"><span className="label-light">Teléfono</span>
            <input className="input-light" type="tel" required autoComplete="tel" value={form.phone} onChange={set('phone')} />
          </label>
          <label className="block"><span className="label-light">Contraseña</span>
            <input className="input-light" type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
            <span className="mt-1 block text-xs text-gray-500">Mínimo 8 caracteres.</span>
          </label>
          <button className="btn-brand w-full py-3" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Crear cuenta</button>
        </form>
      </AuthBox>
    </PortalOnly>
  );
}

/** Perfil y direcciones guardadas. */
export function AccountPage() {
  const { customer, refreshCustomer, logout } = useSiteCtx();
  const navigate = useNavigate();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [profile, setProfile] = useState({ name: '', phone: '' });
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'warning'; text: string } | null>(null);

  const load = useCallback(() => {
    portalApi<{ customer: Customer; addresses: Address[] }>('/portal/me')
      .then((r) => { setAddresses(r.addresses); setProfile({ name: r.customer.name, phone: r.customer.phone || '' }); })
      .catch((e) => setMsg({ kind: 'error', text: errorMessage(e) }));
  }, []);
  useEffect(load, [load]);

  if (!session.getToken('customer')) return <Navigate to="/cuenta/entrar?volver=/cuenta" replace />;
  if (!addresses) return <div className="flex justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    try {
      await portalApi('/portal/me', { method: 'PATCH', body: profile });
      refreshCustomer();
      setMsg({ kind: 'warning', text: 'Datos guardados.' });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    }
  }
  async function removeAddress(a: Address) {
    if (!window.confirm(`¿Borrar "${a.label}"?`)) return;
    try { await portalApi(`/portal/me/addresses/${a.id}`, { method: 'DELETE' }); load(); } catch (err) { setMsg({ kind: 'error', text: errorMessage(err) }); }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold"><UserRound className="h-6 w-6 text-brand" /> Mi cuenta</h1>
        <button className="btn-outline py-2" onClick={() => { logout(); navigate('/', { replace: true }); }}><LogOut className="h-4 w-4" /> Salir</button>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Link to="/cuenta/pedidos" className="card-light flex items-center justify-between p-4 font-semibold hover:border-brand/50">
        <span className="flex items-center gap-2"><ClipboardList className="h-5 w-5 text-brand" /> Mis pedidos</span><ChevronRight className="h-5 w-5 text-gray-400" />
      </Link>
      <form onSubmit={saveProfile} className="card-light space-y-3 p-5">
        <h2 className="font-bold">Mis datos</h2>
        <p className="text-sm text-gray-500">{customer?.email}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label-light">Nombre</span>
            <input className="input-light" required value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
          </label>
          <label className="block"><span className="label-light">Teléfono</span>
            <input className="input-light" type="tel" required value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
          </label>
        </div>
        <button className="btn-brand">Guardar</button>
      </form>
      <section className="card-light p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-bold">Mis direcciones</h2>
          <button className="btn-outline py-1.5" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Agregar</button>
        </div>
        {addresses.length === 0 && <p className="text-sm text-gray-500">Aún no tienes direcciones guardadas.</p>}
        <ul className="divide-y divide-gray-100">
          {addresses.map((a) => (
            <li key={a.id} className="flex items-start gap-3 py-3 text-sm">
              <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
              <div className="min-w-0 flex-1"><b>{a.label}</b><div>{a.address}</div>{a.reference && <div className="text-gray-500">{a.reference}</div>}</div>
              <button className="rounded-full p-1.5 text-gray-400 hover:text-gray-800" onClick={() => setEditing(a)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
              <button className="rounded-full p-1.5 text-gray-400 hover:text-red-600" onClick={() => removeAddress(a)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
        {editing && <AddressForm address={editing === 'new' ? null : editing} onDone={() => { setEditing(null); load(); }} />}
      </section>
    </div>
  );
}

function AddressForm({ address, onDone }: { address: Address | null; onDone: () => void }) {
  const [f, setF] = useState({ label: address?.label || 'Casa', address: address?.address || '', reference: address?.reference || '' });
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await portalApi(address ? `/portal/me/addresses/${address.id}` : '/portal/me/addresses', {
        method: address ? 'PATCH' : 'POST', body: { ...f, reference: f.reference || null },
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-2xl bg-gray-50 p-4">
      {error && <Notice kind="error">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <label className="block"><span className="label-light">Nombre</span><input className="input-light" maxLength={40} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
        <label className="block"><span className="label-light">Dirección</span><input className="input-light" required maxLength={400} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      </div>
      <label className="block"><span className="label-light">Referencias</span><input className="input-light" maxLength={200} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
      <div className="flex justify-end gap-2"><button type="button" className="btn-outline py-2" onClick={onDone}>Cancelar</button><button className="btn-brand py-2">Guardar</button></div>
    </form>
  );
}

/** Historial de pedidos (con cuenta) o pedidos recientes de este navegador (invitado). */
export function OrdersPage() {
  const { customer } = useSiteCtx();
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null);
  const [error, setError] = useState('');
  const logged = Boolean(session.getToken('customer'));

  useEffect(() => {
    if (!logged) return undefined;
    const load = () => portalApi<{ orders: CustomerOrder[] }>('/portal/orders').then((r) => setOrders(r.orders)).catch((e) => setError(errorMessage(e)));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [logged, customer?.id]);

  if (!logged) {
    const recent = recentOrders.list();
    return (
      <PortalOnly>
        <div className="mx-auto max-w-2xl px-4 py-8">
          <h1 className="mb-4 text-2xl font-bold">Mis pedidos</h1>
          <p className="mb-4 text-sm text-gray-600"><Link to="/cuenta/entrar?volver=/cuenta/pedidos" className="font-semibold text-brand">Inicia sesión</Link> para ver todo tu historial.</p>
          {recent.length > 0 && (
            <ul className="card-light divide-y divide-gray-100">
              {recent.map((o) => (
                <li key={o.token}><Link to={`/pedido/${o.token}`} className="flex items-center justify-between p-4 hover:bg-gray-50">
                  <span>Pedido #{o.folio} · <span className="text-gray-500">{formatDateTimeShort(o.created_at)}</span></span><ChevronRight className="h-5 w-5 text-gray-400" />
                </Link></li>
              ))}
            </ul>
          )}
        </div>
      </PortalOnly>
    );
  }

  return (
    <PortalOnly>
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-4 text-2xl font-bold">Mis pedidos</h1>
        {error && <Notice kind="error">{error}</Notice>}
        {!orders ? <div className="flex justify-center py-16 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
          : orders.length === 0 ? <p className="text-gray-500">Aún no tienes pedidos. <Link to="/pedir" className="font-semibold text-brand">Ver el menú</Link></p>
            : (
              <ul className="space-y-3">
                {orders.map((o) => (
                  <li key={o.id}>
                    <Link to={`/pedido/${o.token}`} className="card-light flex items-center gap-3 p-4 hover:border-brand/50">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">#{o.folio}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[o.status]}`}>{o.status_label}</span>
                        </div>
                        <p className="mt-1 truncate text-sm text-gray-500">
                          {formatDateTimeShort(o.created_at)} · {o.branch.name} · {o.items.map((i) => `${i.quantity} ${i.name}`).join(', ')}
                        </p>
                      </div>
                      <span className="font-semibold">{formatMXN(o.total)}</span>
                      <ChevronRight className="h-5 w-5 text-gray-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </PortalOnly>
  );
}
