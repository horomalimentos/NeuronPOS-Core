import { Camera, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay } from '../lib/format';
import { uploadPhoto } from '../lib/upload';
import { formatDateTime } from '../pos/lib';
import type { Employee } from './types';

export interface Incident {
  id: string; employee_id: string; employee_name: string; kind: string; occurred_on: string;
  description: string; action_taken: string | null; evidence: string[]; status: 'pendiente' | 'firmada' | 'cerrada';
  employee_comment: string | null; employee_signed_at: string | null; created_by_name: string | null; created_at: string;
}
const INCIDENT_KIND_LABEL: Record<string, string> = { retardo: 'Retardo', falta: 'Falta', conducta: 'Conducta', accidente: 'Accidente', otro: 'Otro' };
const STATUS_STYLE = { pendiente: 'bg-amber-500/15 text-amber-300', firmada: 'bg-sky-500/15 text-sky-300', cerrada: 'bg-gray-800 text-gray-400' };
const STATUS_LABEL = { pendiente: 'Por firmar', firmada: 'Firmada', cerrada: 'Cerrada' };

/** Acta de lo que paso, con evidencia; el empleado la firma de enterado desde "Mi nómina". */
export function IncidentCard({ inc, action }: { inc: Incident; action?: React.ReactNode }) {
  return (
    <article className="card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-white">{inc.employee_name} · {INCIDENT_KIND_LABEL[inc.kind] || inc.kind}</h3>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[inc.status]}`}>{STATUS_LABEL[inc.status]}</span>
      </div>
      <p className="text-xs text-gray-500">{formatDay(inc.occurred_on)}{inc.created_by_name && ` · levantó ${inc.created_by_name}`}</p>
      <p className="mt-2 whitespace-pre-line text-gray-200">{inc.description}</p>
      {inc.action_taken && <p className="mt-1 text-gray-400"><span className="text-gray-500">Medida:</span> {inc.action_taken}</p>}
      {inc.evidence.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {inc.evidence.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Evidencia" className="h-16 w-16 rounded-lg object-cover" /></a>)}
        </div>
      )}
      {inc.employee_signed_at && (
        <p className="mt-2 rounded-lg bg-gray-800/60 p-2 text-gray-300">Firmada {formatDateTime(inc.employee_signed_at)}{inc.employee_comment && <>: “{inc.employee_comment}”</>}</p>
      )}
      {action && <div className="mt-3 flex justify-end">{action}</div>}
    </article>
  );
}

export default function IncidentsPage() {
  const [list, setList] = useState<Incident[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'abiertas' | 'todas'>('abiertas');
  const load = useCallback(() => { api<{ incidents: Incident[] }>('/rh/incidents').then((r) => setList(r.incidents)).catch((e) => setError(errorMessage(e))); }, []);
  useEffect(load, [load]);
  async function close(id: string) {
    try {
      const { incident } = await api<{ incident: Incident }>(`/rh/incidents/${id}/close`, { method: 'POST', body: {} });
      setList((l) => (l || []).map((x) => (x.id === id ? incident : x)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const shown = (list || []).filter((i) => filter === 'todas' || i.status !== 'cerrada');
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-xl bg-gray-900 p-1 text-sm">
          {(['abiertas', 'todas'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-lg px-4 py-1.5 ${filter === f ? 'bg-brand text-brand-contrast' : 'text-gray-400'}`}>{f === 'abiertas' ? 'Abiertas' : 'Todas'}</button>
          ))}
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nueva incidencia</Button>
      </div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!list ? <Spinner /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.length === 0 && <p className="card p-6 text-sm text-gray-500 md:col-span-2">Sin incidencias.</p>}
          {shown.map((i) => (
            <IncidentCard key={i.id} inc={i} action={i.status !== 'cerrada' && <Button variant="secondary" onClick={() => close(i.id)}>Cerrar</Button>} />
          ))}
        </div>
      )}
      {creating && <NewIncidentModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </>
  );
}

function NewIncidentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [form, setForm] = useState({ employee_id: '', kind: 'retardo', occurred_on: new Date().toLocaleDateString('en-CA'), description: '', action_taken: '' });
  const [evidence, setEvidence] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { api<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees.filter((e) => e.active))).catch(() => {}); }, []);
  async function addPhoto(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadPhoto(file);
      setEvidence((ev) => [...ev, url]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/rh/incidents', { method: 'POST', body: { ...form, evidence } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal title="Nueva incidencia" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Empleado">
          <select className="input" required value={form.employee_id} onChange={set('employee_id')}>
            <option value="">Elige…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            <select className="input" value={form.kind} onChange={set('kind')}>
              {Object.entries(INCIDENT_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Fecha"><input type="date" className="input" required value={form.occurred_on} onChange={set('occurred_on')} /></Field>
        </div>
        <Field label="Qué pasó"><textarea className="input min-h-24" required maxLength={2000} value={form.description} onChange={set('description')} /></Field>
        <Field label="Medida tomada (opcional)"><input className="input" maxLength={500} value={form.action_taken} onChange={set('action_taken')} placeholder="Ej. Llamada de atención verbal" /></Field>
        <div className="flex flex-wrap items-center gap-2">
          {evidence.map((u) => (
            <span key={u} className="relative">
              <img src={u} alt="Evidencia" className="h-16 w-16 rounded-lg object-cover" />
              <button type="button" className="absolute -right-1 -top-1 rounded-full bg-gray-900 p-0.5 text-gray-300" onClick={() => setEvidence(evidence.filter((x) => x !== u))} aria-label="Quitar"><X className="h-3.5 w-3.5" /></button>
            </span>
          ))}
          {evidence.length < 6 && (
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300">
              <Camera className="h-4 w-4" /> {uploading ? 'Subiendo…' : 'Agregar foto'}
              <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => addPhoto(e.target.files?.[0])} />
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving} disabled={uploading}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
