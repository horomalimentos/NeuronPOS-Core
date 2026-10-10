import { CheckCircle2, ExternalLink, Store } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';
import { Alert, Button, Field } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { resetBranding } from '../lib/branding';
import SignupShell from './SignupShell';

interface Created { restaurant: { id: string; slug: string; name: string }; admin_url: string }

/**
 * Registro gratis de un restaurante en NeuronPOS Delivery: datos del
 * negocio, ubicacion en el mapa y la cuenta del administrador. Crea su
 * cuenta de NeuronPOS (solo con el modulo Delivery, sin costo) y le da la
 * direccion de su panel para subir menu y horario.
 */
export default function RestaurantSignupPage() {
  const [form, setForm] = useState({ name: '', cuisine: '', phone: '', address: '', adminName: '', email: '', password: '' });
  const [location, setLocation] = useState<Point | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Created | null>(null);
  useEffect(() => { resetBranding(); document.title = 'Registra tu restaurante · NeuronPOS Delivery'; }, []);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!location) { setError('Marca en el mapa dónde está tu restaurante'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await api<Created>('/marketplace/restaurants', {
        method: 'POST',
        noRedirect: true,
        body: {
          name: form.name, cuisine: form.cuisine || null, phone: form.phone, address: form.address, location,
          admin: { name: form.adminName, email: form.email, password: form.password },
        },
      });
      setDone(r);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  if (done) {
    return (
      <SignupShell icon={<CheckCircle2 className="h-8 w-8" />} title="¡Listo!" subtitle={`${done.restaurant.name} ya tiene su cuenta`}>
        <div className="space-y-4 text-sm text-gray-300">
          <p>Entra a tu panel con tu correo y contraseña. Antes de aparecer en NeuronPOS Delivery te falta:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Subir tu menú (Menú).</li>
            <li>Poner tu horario (Sucursales › Horario).</li>
            <li>Publicar tu restaurante (Delivery).</li>
          </ol>
          <p className="rounded-xl bg-gray-950/60 p-3">Tu panel: <a className="break-all text-brand" href={done.admin_url}>{done.admin_url}</a></p>
          <a href={done.admin_url} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 font-semibold text-brand-contrast">
            Ir a mi panel <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </SignupShell>
    );
  }

  return (
    <SignupShell icon={<Store className="h-8 w-8" />} title="Registra tu restaurante" subtitle="Gratis, sin mensualidad">
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del restaurante">
            <input className="input" required maxLength={120} value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Tipo de comida" hint="Ej. tacos, sushi, pizza">
            <input className="input" maxLength={60} value={form.cuisine} onChange={set('cuisine')} />
          </Field>
          <Field label="Teléfono del restaurante">
            <input className="input" type="tel" required value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Dirección">
            <input className="input" required maxLength={300} value={form.address} onChange={set('address')} />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-300">Ubicación</p>
          <MapTools onPoint={setLocation} near={location} initialQuery={form.address} />
          <ZoneMap className="h-64" center={null} tiers={[]} pin={location} onPick={setLocation} />
          <p className="text-xs text-gray-500">{location ? 'Puedes arrastrar el pin para ajustarlo.' : 'Busca tu dirección o toca el mapa donde está tu restaurante.'}</p>
        </div>
        <div className="grid gap-4 border-t border-gray-800 pt-5 sm:grid-cols-2">
          <Field label="Tu nombre">
            <input className="input" required maxLength={120} value={form.adminName} onChange={set('adminName')} />
          </Field>
          <Field label="Correo">
            <input className="input" type="email" autoComplete="username" required value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Contraseña" hint="Mínimo 8 caracteres">
            <input className="input" type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={set('password')} />
          </Field>
        </div>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">Crear mi cuenta gratis</Button>
      </form>
    </SignupShell>
  );
}
