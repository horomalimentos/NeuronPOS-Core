import { Bike } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Point } from '../components/ZoneMap';
import { Alert, Button, Field } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { session } from '../lib/session';
import type { MarketplaceInfo } from './lib';
import SignupShell from './SignupShell';
import ZoneFields from './ZoneFields';

/**
 * Registro de repartidor de NeuronPOS Delivery: datos, vehiculo, epicentro y
 * km a la redonda. Queda en revision hasta que NeuronPOS lo aprueba; mientras
 * puede entrar a su app (/repartidor) y ver el estado.
 */
export default function DriverSignupPage() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<MarketplaceInfo | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '', vehicle: 'Moto', plate: '' });
  const [base, setBase] = useState<Point | null>(null);
  const [radius, setRadius] = useState(5);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    resetBranding();
    document.title = 'Reparte con NeuronPOS Delivery';
    api<MarketplaceInfo>('/marketplace/info', { noRedirect: true }).then(setInfo).catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!base) { setError('Marca tu epicentro en el mapa'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string }>('/marketplace/drivers', {
        method: 'POST', noRedirect: true, body: { ...form, plate: form.plate || null, base, radius_km: radius },
      });
      session.setToken('fleet', r.token);
      session.setToken('restaurant', null);
      navigate('/repartidor', { replace: true });
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <SignupShell icon={<Bike className="h-8 w-8" />} title="Reparte con NeuronPOS"
      subtitle={`Sin mensualidad · te quedas con el ${info?.driver_share_pct ?? 80} % de cada envío`}>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre completo">
            <input className="input" required maxLength={120} value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Celular">
            <input className="input" type="tel" required value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Vehículo">
            <select className="input" value={form.vehicle} onChange={set('vehicle')}>
              {['Moto', 'Bicicleta', 'Auto', 'A pie'].map((v) => <option key={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Placas" hint="Si tu vehículo tiene">
            <input className="input" maxLength={20} value={form.plate} onChange={set('plate')} />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-gray-300">Tu zona</p>
          <ZoneFields base={base} radius={radius} maxRadius={info?.driver_max_radius_km ?? 15} onBase={setBase} onRadius={setRadius} />
        </div>
        <div className="grid gap-4 border-t border-gray-800 pt-5 sm:grid-cols-2">
          <Field label="Correo">
            <input className="input" type="email" autoComplete="username" required value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Contraseña" hint="Mínimo 8 caracteres">
            <input className="input" type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={set('password')} />
          </Field>
        </div>
        <p className="text-xs text-gray-500">
          NeuronPOS revisa tu registro antes de que puedas conectarte. En pedidos en efectivo cobras al cliente, pagas la
          comida en el restaurante y te quedas con el envío; la parte de NeuronPOS se te descuenta de los pedidos con tarjeta.
        </p>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">Registrarme</Button>
      </form>
    </SignupShell>
  );
}
