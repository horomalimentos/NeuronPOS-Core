import { LogIn, Mail, MailCheck, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '../components/ui';
import { errorMessage, nayoApi } from '../lib/api';
import { accountStore, signIn, signOut, type NayoAccount } from './customer';
import GoogleSignIn from './GoogleSignIn';

/**
 * Crear cuenta o entrar a Nayo. Para hacer un pedido hay que tener cuenta;
 * la misma sirve en todos los restaurantes de Nayo.
 */
export default function NayoAccountForm({ onDone }: { onDone?: () => void }) {
  const [mode, setMode] = useState<'register' | 'login' | 'forgot'>('register');
  const [sent, setSent] = useState(false);
  const [f, setF] = useState({ name: '', phone: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'forgot') {
        await nayoApi('/marketplace/account/forgot', { method: 'POST', body: { email: f.email } });
        setSent(true);
        setBusy(false);
        return;
      }
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
    <button type="button" onClick={() => { setMode(m); setError(''); setSent(false); }}
      className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${mode === m ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
  );

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-gray-300">Para hacer tu pedido crea tu cuenta de Nayo o entra con la que ya tienes.</p>
      {mode !== 'forgot' && <GoogleSignIn onDone={onDone} />}
      <div className="flex gap-1 rounded-xl bg-gray-950/60 p-1">{tab('register', 'Crear cuenta')}{tab('login', 'Ya tengo cuenta')}</div>
      {mode === 'forgot' && <p className="text-sm text-gray-300">Escribe el correo de tu cuenta y te mandamos una liga para cambiar tu contraseña.</p>}
      {mode === 'register' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Nombre"><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={set('name')} /></Field>
          <Field label="Teléfono"><input className="input" type="tel" required autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
        </div>
      )}
      <Field label="Correo"><input className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field>
      {mode !== 'forgot' && (
        <Field label="Contraseña" hint={mode === 'register' ? 'Mínimo 8 caracteres' : undefined}>
          <input className="input" type="password" required minLength={mode === 'register' ? 8 : undefined}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} />
        </Field>
      )}
      {error && <Alert>{error}</Alert>}
      {mode === 'forgot' && sent ? (
        <Alert kind="success">Si hay una cuenta con ese correo, te mandamos una liga para cambiar tu contraseña. Revisa también la carpeta de spam.</Alert>
      ) : (
        <Button type="submit" loading={busy} className="w-full">
          {mode === 'register' ? <><UserPlus className="h-4 w-4" /> Crear cuenta y seguir</>
            : mode === 'login' ? <><LogIn className="h-4 w-4" /> Entrar y seguir</>
            : <><Mail className="h-4 w-4" /> Mandarme la liga</>}
        </Button>
      )}
      {mode === 'login' && (
        <button type="button" onClick={() => { setMode('forgot'); setError(''); setSent(false); }} className="w-full text-center text-xs text-gray-400 underline hover:text-white">
          ¿Olvidaste tu contraseña?
        </button>
      )}
    </form>
  );
}

/**
 * Confirmar el correo: al crear la cuenta le mandamos un codigo de 6 digitos;
 * sin escribirlo no puede pedir.
 */
export function VerifyEmailForm({ account, onDone }: { account: NayoAccount; onDone?: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy('verify');
    setError('');
    try {
      const r = await nayoApi<{ customer: NayoAccount }>('/marketplace/account/verify', { method: 'POST', body: { code } });
      accountStore.set(r.customer);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy('');
  }

  async function resend() {
    setBusy('resend');
    setError('');
    setNote('');
    try {
      const r = await nayoApi<{ sent: boolean }>('/marketplace/account/verify/resend', { method: 'POST', body: {} });
      setNote(r.sent ? 'Te mandamos un código nuevo.' : 'Espera un minuto para pedir otro código.');
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy('');
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="flex items-start gap-2 text-sm text-gray-300">
        <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <span>Te mandamos un código de 6 dígitos a <b className="text-white">{account.email}</b>. Escríbelo para confirmar tu correo. Si no lo ves, revisa spam.</span>
      </p>
      <Field label="Código">
        <input className="input text-center text-2xl tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" required
          pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      </Field>
      {error && <Alert>{error}</Alert>}
      {note && <Alert kind="success">{note}</Alert>}
      <Button type="submit" loading={busy === 'verify'} disabled={code.length !== 6} className="w-full">
        <MailCheck className="h-4 w-4" /> Confirmar y seguir
      </Button>
      <div className="flex justify-between text-xs text-gray-400">
        <button type="button" disabled={busy !== ''} onClick={() => void resend()} className="underline hover:text-white">Mandar otro código</button>
        <button type="button" onClick={signOut} className="underline hover:text-white">Usar otro correo</button>
      </div>
    </form>
  );
}
