import { LogIn, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '../components/ui';
import { errorMessage, nayoApi } from '../lib/api';
import { signIn, type NayoAccount } from './customer';

/**
 * Crear cuenta o entrar a Nayo. Para hacer un pedido hay que tener cuenta;
 * la misma sirve en todos los restaurantes de Nayo.
 */
export default function NayoAccountForm({ onDone }: { onDone?: () => void }) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [f, setF] = useState({ name: '', phone: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = mode === 'register'
        ? await nayoApi<{ token: string; customer: NayoAccount }>('/marketplace/account/register', { method: 'POST', body: f })
        : await nayoApi<{ token: string; customer: NayoAccount }>('/marketplace/account/login', { method: 'POST', body: { email: f.email, password: f.password } });
      signIn(r.token, r.customer);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  const tab = (m: typeof mode, label: string) => (
    <button type="button" onClick={() => { setMode(m); setError(''); }}
      className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${mode === m ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
  );

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-gray-300">Para hacer tu pedido crea tu cuenta de Nayo o entra con la que ya tienes.</p>
      <div className="flex gap-1 rounded-xl bg-gray-950/60 p-1">{tab('register', 'Crear cuenta')}{tab('login', 'Ya tengo cuenta')}</div>
      {mode === 'register' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Nombre"><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={set('name')} /></Field>
          <Field label="Teléfono"><input className="input" type="tel" required autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
        </div>
      )}
      <Field label="Correo"><input className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Contraseña" hint={mode === 'register' ? 'Mínimo 8 caracteres' : undefined}>
        <input className="input" type="password" required minLength={mode === 'register' ? 8 : undefined}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} />
      </Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" loading={busy} className="w-full">
        {mode === 'register' ? <><UserPlus className="h-4 w-4" /> Crear cuenta y seguir</> : <><LogIn className="h-4 w-4" /> Entrar y seguir</>}
      </Button>
    </form>
  );
}
