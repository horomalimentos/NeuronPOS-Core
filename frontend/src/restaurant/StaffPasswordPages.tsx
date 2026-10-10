import { KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthCard } from '../components/AuthCard';
import { Alert, Button, Field } from '../components/ui';
import { api, errorMessage } from '../lib/api';

const logo = <div className="mb-5 rounded-2xl bg-brand/15 p-3 text-brand"><KeyRound className="h-9 w-9" /></div>;
const back = <Link to="/admin/login" className="block text-center text-xs text-gray-500 hover:text-gray-300">Volver a iniciar sesión</Link>;

/** El personal pide una liga para cambiar su contraseña (respuesta siempre igual). */
export function StaffForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api('/auth/forgot', { method: 'POST', body: { email }, noRedirect: true });
      setSent(true);
    } catch (err) { setError(errorMessage(err)); }
    setLoading(false);
  }
  return (
    <AuthCard title="¿Olvidaste tu contraseña?" subtitle="Te mandamos una liga a tu correo para crear una nueva" logo={logo}>
      {sent ? (
        <div className="space-y-5">
          <Alert kind="success">Si el correo tiene una cuenta, te llegará una liga en unos minutos. Vale 60 minutos y se usa una vez.</Alert>
          {back}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {error && <Alert>{error}</Alert>}
          <Field label="Correo">
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" loading={loading} className="w-full">Mandar liga</Button>
          {back}
        </form>
      )}
    </AuthCard>
  );
}

/** Pantalla de la liga del correo: nueva contraseña del personal. */
export function StaffResetPage() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // Se quita el token de la barra de direcciones (historial).
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Las contraseñas no coinciden'); return; }
    setError('');
    setLoading(true);
    try {
      await api('/auth/reset', { method: 'POST', body: { token, password }, noRedirect: true });
      setDone(true);
    } catch (err) { setError(errorMessage(err)); }
    setLoading(false);
  }
  return (
    <AuthCard title="Nueva contraseña" subtitle="Al cambiarla se cierran tus sesiones abiertas" logo={logo}>
      {!token ? (
        <div className="space-y-5">
          <Alert>La liga no es válida. Pide una nueva.</Alert>
          <Link to="/admin/olvide" className="block text-center text-sm text-brand hover:underline">Pedir otra liga</Link>
        </div>
      ) : done ? (
        <div className="space-y-5">
          <Alert kind="success">Listo, tu contraseña cambió.</Alert>
          <Button className="w-full" onClick={() => navigate('/admin/login', { replace: true })}>Iniciar sesión</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {error && <Alert>{error}</Alert>}
          <Field label="Nueva contraseña" hint="Mínimo 8 caracteres">
            <input className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repítela">
            <input className="input" type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" loading={loading} className="w-full">Guardar</Button>
          {back}
        </form>
      )}
    </AuthCard>
  );
}
