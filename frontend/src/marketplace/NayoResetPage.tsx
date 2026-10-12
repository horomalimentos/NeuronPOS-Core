import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '../components/ui';
import { errorMessage, nayoApi } from '../lib/api';
import { signIn, type NayoAccount } from './customer';
import { nayoPath } from './nayoUrl';
import SignupShell from './SignupShell';

/** Liga del correo "Cambia tu contraseña de Nayo" (el token viene en #token=...). */
export default function NayoResetPage() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await nayoApi<{ token: string; customer: NayoAccount }>('/marketplace/account/reset', { method: 'POST', body: { token, password } });
      signIn(r.token, r.customer);
      navigate(nayoPath(), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <SignupShell icon={<KeyRound className="h-8 w-8" />} title="Cambia tu contraseña" subtitle="Tu cuenta de Nayo">
      {!token ? <Alert>La liga no es válida. Pide otra desde "¿Olvidaste tu contraseña?".</Alert> : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Contraseña nueva" hint="Mínimo 8 caracteres">
            <input className="input" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={busy} className="w-full">Guardar y entrar</Button>
        </form>
      )}
    </SignupShell>
  );
}
