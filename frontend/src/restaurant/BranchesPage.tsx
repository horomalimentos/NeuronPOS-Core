import { MapPin, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Branch } from '../lib/types';
import { canManage, useAdmin } from './context';

const TIMEZONES = [
  'America/Ciudad_Juarez', 'America/Chihuahua', 'America/Mexico_City', 'America/Monterrey',
  'America/Hermosillo', 'America/Mazatlan', 'America/Tijuana', 'America/Cancun',
];

export default function BranchesPage() {
  const { me, reload: reloadMe } = useAdmin();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);

  const load = useCallback(() => {
    api<{ branches: Branch[] }>('/branches').then((r) => setBranches(r.branches)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  if (!canManage(me.user.role)) return <Navigate to="/admin" replace />;
  const isAdmin = me.user.role === 'admin';

  async function remove(b: Branch) {
    if (!window.confirm(`¿Borrar la sucursal "${b.name}"?`)) return;
    try {
      await api(`/branches/${b.id}`, { method: 'DELETE' });
      load();
      reloadMe();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader title="Sucursales" actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nueva sucursal</Button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!branches ? <Spinner /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          {branches.map((b) => (
            <div key={b.id} className={`card p-5 ${b.active ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-white">{b.name}</h3>
                  {!b.active && <span className="text-xs text-amber-300">Inactiva</span>}
                </div>
                <div className="flex gap-1">
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(b)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                  {isAdmin && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(b)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>}
                </div>
              </div>
              <dl className="mt-3 space-y-1 text-sm text-gray-400">
                {b.address && <div className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" />{b.address}</div>}
                {b.phone && <div className="flex gap-2"><Phone className="mt-0.5 h-4 w-4 flex-shrink-0" />{b.phone}</div>}
                <div className="text-xs text-gray-600">{b.timezone}</div>
              </dl>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <BranchModal
          branch={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); reloadMe(); }}
        />
      )}
    </>
  );
}

function BranchModal({ branch, onClose, onSaved }: { branch: Branch | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: branch?.name || '', address: branch?.address || '', phone: branch?.phone || '',
    timezone: branch?.timezone || 'America/Ciudad_Juarez', active: branch?.active ?? true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { ...form, address: form.address || null, phone: form.phone || null };
      await api(branch ? `/branches/${branch.id}` : '/branches', { method: branch ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={branch ? 'Editar sucursal' : 'Nueva sucursal'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Dirección"><input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <Field label="Teléfono"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Zona horaria">
          <select className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {[...new Set([form.timezone, ...TIMEZONES])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
        <div className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Sucursal activa" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Sucursal activa
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
