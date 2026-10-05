import { BrainCircuit } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthCard } from '../components/AuthCard';
import { Alert, Button, Field } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { session } from '../lib/session';

export default function PlatformLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await platformApi<{ token: string }>('/platform/auth/login', {
        method: 'POST', body: { email, password }, noRedirect: true,
      });
      session.setToken('platform', res.token);
      navigate('/panel', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Panel NeuronPOS"
      subtitle="Administración de restaurantes y suscripciones"
      logo={<div className="mb-5 rounded-2xl bg-brand/15 p-3 text-brand"><BrainCircuit className="h-9 w-9" /></div>}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <Field label="Correo">
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Contraseña">
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" loading={loading} className="w-full">Entrar</Button>
      </form>
    </AuthCard>
  );
}
