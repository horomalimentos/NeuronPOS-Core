import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { num } from './lib';
import type { PaymentMethod, SalesChannel } from './types';

/**
 * Plataformas de delivery (Rappi, Uber Eats, Didi...) en Ajustes del POS: su
 * comision, con que se cobran y que datos se piden al capturar el pedido.
 */
export default function ChannelsCard({ methods }: { methods: PaymentMethod[] }) {
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [editing, setEditing] = useState<SalesChannel | 'new' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ channels: SalesChannel[] }>('/pos/channels?all=1').then((r) => setChannels(r.channels)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  async function remove(c: SalesChannel) {
    if (!window.confirm(`¿Borrar "${c.name}"?`)) return;
    try {
      const r = await api<{ archived?: boolean } | undefined>(`/pos/channels/${c.id}`, { method: 'DELETE' });
      if (r?.archived) window.alert('Ya tiene ventas registradas: se desactivó en lugar de borrarse.');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const methodName = (id: string) => methods.find((m) => m.id === id)?.name;
  return (
    <section className="card p-5 lg:col-span-2">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold text-white">Plataformas de delivery</h2>
        <Button variant="secondary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Agregar</Button>
      </div>
      <p className="mb-3 text-sm text-gray-400">
        Rappi, Uber Eats, Didi Food… Al tomar una orden para llevar o a domicilio se elige de dónde viene. Los reportes muestran la venta, la comisión y lo que te queda.
      </p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {channels.length === 0 ? <p className="text-sm text-gray-500">Sin plataformas: todas las ventas son propias.</p> : (
        <ul className="divide-y divide-gray-800">
          {channels.map((c) => (
            <li key={c.id} className={`flex items-center gap-3 py-2.5 ${c.active ? '' : 'opacity-50'}`}>
              <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ background: c.color || '#6b7280' }} />
              <span className="flex-1 text-gray-200">
                {c.name}
                <span className="block text-xs text-gray-500">
                  Comisión {num(c.commission_pct)}%
                  {c.payment_method_ids.length > 0 && ` · se cobra con ${c.payment_method_ids.map(methodName).filter(Boolean).join(', ')}`}
                  {!c.active && ' · inactiva'}
                </span>
              </span>
              <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(c)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
              <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(c)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ChannelModal channel={editing === 'new' ? null : editing} methods={methods}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}

function ChannelModal({ channel, methods, onClose, onSaved }: {
  channel: SalesChannel | null; methods: PaymentMethod[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: channel?.name || '', color: channel?.color || '#22c55e', commission_pct: String(channel ? num(channel.commission_pct) : ''),
    payment_method_ids: channel?.payment_method_ids || [], requires_order_number: channel?.requires_order_number ?? true,
    requires_address: channel?.requires_address ?? false, active: channel?.active ?? true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const usable = methods.filter((m) => m.kind !== 'en_linea' && (m.active || form.payment_method_ids.includes(m.id)));
  const toggle = (id: string) => setForm((f) => ({
    ...f, payment_method_ids: f.payment_method_ids.includes(id) ? f.payment_method_ids.filter((x) => x !== id) : [...f.payment_method_ids, id],
  }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(channel ? `/pos/channels/${channel.id}` : '/pos/channels', {
        method: channel ? 'PATCH' : 'POST', body: { ...form, commission_pct: num(form.commission_pct) },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={channel ? 'Editar plataforma' : 'Nueva plataforma'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-[1fr_auto] gap-4">
          <Field label="Nombre"><input className="input" required maxLength={60} value={form.name} placeholder="Ej. Rappi" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Color"><input className="input h-[42px] w-16 p-1" type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></Field>
        </div>
        <Field label="Comisión (%)" hint="Lo que cobra la plataforma sobre cada venta">
          <input className="input" type="number" min="0" max="100" step="0.01" required value={form.commission_pct} onChange={(e) => setForm({ ...form, commission_pct: e.target.value })} />
        </Field>
        <div>
          <span className="label">Se cobra con</span>
          <div className="flex flex-wrap gap-2">
            {usable.map((m) => {
              const on = form.payment_method_ids.includes(m.id);
              return (
                <button key={m.id} type="button" onClick={() => toggle(m.id)}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${on ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>{m.name}</button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-gray-500">Sin ninguno marcado se puede cobrar con cualquier método. Tip: crea un método “Rappi (pagado)” de tipo Otro para lo que la plataforma ya cobró.</p>
        </div>
        <label className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Pedir número de pedido" checked={form.requires_order_number} onChange={(v) => setForm({ ...form, requires_order_number: v })} /> Pedir el número de pedido de la plataforma
        </label>
        <label className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Pedir dirección" checked={form.requires_address} onChange={(v) => setForm({ ...form, requires_address: v })} /> Pedir la dirección de entrega
        </label>
        <label className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Activa" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Activa
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
