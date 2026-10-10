import { Search, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { fmtPoints, type LoyaltyCustomer } from './types';

/** Buscar un cliente por nombre, telefono o correo, o darlo de alta (nombre y telefono). */
export default function CustomerPicker({ initialQuery = '', onPick, onClose }: {
  initialQuery?: string; onPick: (c: LoyaltyCustomer) => void; onClose: () => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [list, setList] = useState<LoyaltyCustomer[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: /^\D*\d/.test(initialQuery) ? initialQuery : '', email: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ customers: LoyaltyCustomer[] }>(`/loyalty/customers?limit=20&q=${encodeURIComponent(q.trim())}`)
        .then((r) => setList(r.customers)).catch((e) => setError(errorMessage(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ customer: LoyaltyCustomer }>('/loyalty/customers', {
        method: 'POST', body: { name: form.name, phone: form.phone, email: form.email || undefined },
      });
      onPick(r.customer);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={creating ? 'Nuevo cliente' : 'Cliente'} onClose={onClose}>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {creating ? (
        <form onSubmit={create} className="space-y-4">
          <Field label="Nombre"><input className="input" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Teléfono" hint="Con él se le encuentra la próxima vez.">
            <input className="input" type="tel" required maxLength={30} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Correo (opcional)" hint="Si se registra en el sitio con este correo, conserva sus puntos.">
            <input className="input" type="email" maxLength={200} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Volver</Button>
            <Button type="submit" loading={busy}>Guardar y usar</Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input className="input pl-9" placeholder="Teléfono, nombre o correo" value={q} autoFocus
              onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" />
          </label>
          {!list && !error && <Spinner />}
          {list && (
            <div className="max-h-80 divide-y divide-gray-800/70 overflow-y-auto rounded-xl border border-gray-800">
              {list.length === 0 && <p className="p-4 text-sm text-gray-500">Sin resultados.</p>}
              {list.map((c) => (
                <button key={c.id} type="button" onClick={() => onPick(c)} disabled={!c.active}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-gray-800/60 disabled:opacity-40">
                  <span>
                    <span className="text-white">{c.name}</span>
                    <span className="block text-xs text-gray-500">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="text-right text-sm tabular-nums text-gray-300">{fmtPoints(c.points_balance)} pts</span>
                </button>
              ))}
            </div>
          )}
          <Button variant="secondary" className="w-full" onClick={() => {
            setForm((f) => ({ ...f, phone: f.phone || (/\d{7,}/.test(q.replace(/\D/g, '')) ? q : ''), name: f.name || (/\d/.test(q) ? '' : q) }));
            setCreating(true);
          }}><UserPlus className="h-4 w-4" /> Nuevo cliente</Button>
        </div>
      )}
    </Modal>
  );
}
