import { useState, type FormEvent } from 'react';
import { Store } from 'lucide-react';
import { AuthCard } from '../components/AuthCard';
import { Button, Field } from '../components/ui';
import { session } from '../lib/session';

// Cuando no se pudo saber el restaurante por el dominio (p. ej. localhost),
// se pide el slug. En produccion cada restaurante entra por su subdominio.
export default function TenantPicker() {
  const [slug, setSlug] = useState(session.getDevSlug() || '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    session.setToken('restaurant', null);
    session.setDevSlug(slug.trim().toLowerCase() || null);
    window.location.reload();
  };
  return (
    <AuthCard
      title="¿Cuál es tu restaurante?"
      subtitle="Escribe el identificador (slug) de tu restaurante"
      logo={<div className="mb-5 rounded-2xl bg-brand/15 p-3 text-brand"><Store className="h-9 w-9" /></div>}
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Restaurante" hint="Ej. horom (horom.neuronpos.mx)">
          <input className="input" required value={slug} onChange={(e) => setSlug(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full">Continuar</Button>
      </form>
    </AuthCard>
  );
}
