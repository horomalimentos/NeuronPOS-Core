import { Megaphone, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from '../restaurant/context';

interface Announcement {
  id: string; title: string; body: string; priority: 'normal' | 'importante'; branch_name: string | null; area_name: string | null;
  starts_at: string; ends_at: string | null; created_by_name: string | null; reads: number;
}

/** Comunicados al personal (como los avisos de Horom): salen en el Inicio de cada quien. */
export default function AnnouncementsPage() {
  const [list, setList] = useState<Announcement[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => { api<{ announcements: Announcement[] }>('/rh/announcements').then((r) => setList(r.announcements)).catch((e) => setError(errorMessage(e))); }, []);
  useEffect(load, [load]);
  async function remove(a: Announcement) {
    if (!confirm(`¿Borrar "${a.title}"?`)) return;
    try {
      await api(`/rh/announcements/${a.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const now = Date.now();
  return (
    <>
      <div className="mb-4 flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo comunicado</Button></div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!list ? <Spinner /> : (
        <div className="space-y-3">
          {list.length === 0 && <p className="card p-6 text-sm text-gray-500">Sin comunicados.</p>}
          {list.map((a) => {
            const expired = a.ends_at && new Date(a.ends_at).getTime() < now;
            return (
              <article key={a.id} className={`card p-4 ${expired ? 'opacity-50' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="flex items-center gap-2 font-semibold text-white">
                    <Megaphone className={`h-4 w-4 ${a.priority === 'importante' ? 'text-amber-300' : 'text-brand'}`} /> {a.title}
                    {a.priority === 'importante' && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">Importante</span>}
                  </h3>
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(a)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm text-gray-300">{a.body}</p>
                <p className="mt-2 text-xs text-gray-500">
                  {formatDateTime(a.starts_at)} · {a.branch_name || 'Todas las sucursales'}{a.area_name && ` · ${a.area_name}`}
                  {a.ends_at && ` · ${expired ? 'venció' : 'hasta'} ${formatDateTime(a.ends_at)}`} · leído por {a.reads}
                </p>
              </article>
            );
          })}
        </div>
      )}
      {creating && <NewAnnouncementModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </>
  );
}

function NewAnnouncementModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me } = useAdmin();
  const [areas, setAreas] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ title: '', body: '', priority: 'normal', branch_id: '', area_id: '', ends_at: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { api<{ areas: { id: string; name: string }[] }>('/rh/areas').then((r) => setAreas(r.areas)).catch(() => {}); }, []);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/rh/announcements', {
        method: 'POST',
        body: { ...form, branch_id: form.branch_id || null, area_id: form.area_id || null, ends_at: form.ends_at ? new Date(`${form.ends_at}T23:59:59`).toISOString() : null },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Nuevo comunicado" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Título"><input className="input" required maxLength={120} value={form.title} onChange={set('title')} /></Field>
        <Field label="Mensaje"><textarea className="input min-h-28" required maxLength={4000} value={form.body} onChange={set('body')} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sucursal">
            <select className="input" value={form.branch_id} onChange={set('branch_id')}>
              <option value="">Todas</option>
              {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Área">
            <select className="input" value={form.area_id} onChange={set('area_id')}>
              <option value="">Todas</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Prioridad">
            <select className="input" value={form.priority} onChange={set('priority')}>
              <option value="normal">Normal</option>
              <option value="importante">Importante</option>
            </select>
          </Field>
          <Field label="Mostrar hasta (opcional)"><input type="date" className="input" value={form.ends_at} onChange={set('ends_at')} /></Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Publicar</Button>
        </div>
      </form>
    </Modal>
  );
}
