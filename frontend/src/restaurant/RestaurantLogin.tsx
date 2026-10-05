import { Store } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthCard } from '../components/AuthCard';
import { Alert, Button, Field, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { session } from '../lib/session';
import TenantPicker from './TenantPicker';
import { useSite } from './useSite';

export default function RestaurantLogin() {
  const navigate = useNavigate();
  const { site, state } = useSite();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (state === 'loading') return <Spinner />;
  if (state === 'not_found') return <TenantPicker />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api<{ token: string }>('/auth/login', { method: 'POST', body: { email, password }, noRedirect: true });
      session.setToken('restaurant', res.token);
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const r = site?.restaurant;
  return (
    <AuthCard
      title={r?.name || 'Iniciar sesión'}
      subtitle="Ingresa tus credenciales para continuar"
      logo={r?.logo_url
        ? <img src={r.logo_url} alt={r.name} className="mb-5 h-14 object-contain" />
        : <div className="mb-5 rounded-2xl bg-brand/15 p-3 text-brand"><Store className="h-9 w-9" /></div>}
    >
      <form onSubmit={submit} className="space-y-5">
        {state === 'error' && <Alert>No se pudo conectar con el servidor.</Alert>}
        {error && <Alert>{error}</Alert>}
        <Field label="Correo">
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Contraseña">
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" loading={loading} className="w-full">Entrar</Button>
        {session.getDevSlug() && (
          <button type="button" className="w-full text-center text-xs text-gray-500 hover:text-gray-300"
            onClick={() => { session.setDevSlug(null); window.location.reload(); }}>
            Cambiar de restaurante
          </button>
        )}
      </form>
    </AuthCard>
  );
}
