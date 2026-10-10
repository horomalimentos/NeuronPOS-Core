import { Camera, CheckCircle2, Circle, ClipboardCheck, Pencil, Plus, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { uploadPhoto } from '../lib/upload';
import BranchSelect from '../pos/BranchSelect';
import { formatDateTime } from '../pos/lib';
import { usePosBranch } from '../pos/usePosBranch';
import { canManage, useAdmin } from '../restaurant/context';

interface RunItem { id: string; text: string; requires_photo: boolean; done: boolean; photo_url: string | null; note: string | null; done_at: string | null; done_by_name: string | null }
interface Run { id: string; name: string; branch_name: string; run_date: string; status: 'abierto' | 'enviado'; submitted_at: string | null; submitted_by_name: string | null; items: RunItem[] }
interface Template { id: string; name: string; branch_id: string | null; area_id: string | null; active: boolean; items: { id: string; text: string; requires_photo: boolean }[] }
interface HistoryRow { id: string; name: string; run_date: string; status: string; submitted_at: string | null; submitted_by_name: string | null; done: number; total: number }

/**
 * Checklists del dia (como los de Horom): apertura, cierre, limpieza... Cada
 * punto se marca y, si se pide, con foto de evidencia. El gerente arma las
 * plantillas y revisa el historial.
 */
export default function ChecklistsPage() {
  const { me } = useAdmin();
  const manager = canManage(me.user.role);
  const { branchId, setBranchId, branches } = usePosBranch();
  const [tab, setTab] = useState<'hoy' | 'historial' | 'plantillas'>('hoy');
  return (
    <>
      <PageHeader title="Checklists" subtitle="Lo que se revisa cada día en el local, con foto cuando hace falta."
        actions={<BranchSelect branches={branches} value={branchId} onChange={setBranchId} />} />
      {manager && (
        <div className="mb-5 flex gap-1 rounded-xl bg-gray-900 p-1 text-sm sm:w-fit">
          {([['hoy', 'Hoy'], ['historial', 'Historial'], ['plantillas', 'Plantillas']] as const).map(([t, l]) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-4 py-2 font-medium ${tab === t ? 'bg-brand text-brand-contrast' : 'text-gray-400 hover:text-white'}`}>{l}</button>
          ))}
        </div>
      )}
      {!branchId ? null : tab === 'hoy' ? <Today branchId={branchId} /> : tab === 'historial' ? <History branchId={branchId} /> : <Templates />}
    </>
  );
}

function Today({ branchId }: { branchId: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    api<{ runs: Run[] }>(`/rh/checklists/today?branch_id=${branchId}`).then((r) => setRuns(r.runs)).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(load, [load]);
  const replace = (run: Run) => setRuns((rs) => (rs || []).map((r) => (r.id === run.id ? run : r)));

  async function mark(run: Run, item: RunItem, patch: { done: boolean; photo_url?: string }) {
    setBusy(item.id);
    setError('');
    try {
      replace((await api<{ run: Run }>(`/rh/checklists/runs/${run.id}/items/${item.id}`, { method: 'PUT', body: patch })).run);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }
  async function photo(run: Run, item: RunItem, file: File | undefined) {
    if (!file) return;
    setBusy(item.id);
    try {
      const url = await uploadPhoto(file);
      await mark(run, item, { done: true, photo_url: url });
    } catch (err) {
      setError(errorMessage(err));
      setBusy('');
    }
  }
  async function submit(run: Run) {
    setError('');
    try {
      replace((await api<{ run: Run }>(`/rh/checklists/runs/${run.id}/submit`, { method: 'POST', body: {} })).run);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!runs) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <div className="space-y-5">
      {error && <Alert>{error}</Alert>}
      {runs.length === 0 && <p className="card p-8 text-center text-sm text-gray-400">No hay checklists para hoy en esta sucursal.</p>}
      {runs.map((run) => {
        const done = run.items.filter((i) => i.done && (!i.requires_photo || i.photo_url)).length;
        const sent = run.status === 'enviado';
        return (
          <section key={run.id} className="card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><ClipboardCheck className="h-5 w-5 text-brand" /> {run.name}</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${sent ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-800 text-gray-300'}`}>
                {sent ? `Enviado ${formatDateTime(run.submitted_at)} · ${run.submitted_by_name}` : `${done} de ${run.items.length}`}
              </span>
            </div>
            <ul className="divide-y divide-gray-800">
              {run.items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 py-2.5">
                  <button disabled={sent || busy === it.id} onClick={() => mark(run, it, { done: !it.done })} aria-label={it.done ? 'Desmarcar' : 'Marcar'}
                    className={it.done ? 'text-emerald-400' : 'text-gray-600 hover:text-gray-300'}>
                    {it.done ? <CheckCircle2 className="h-7 w-7" /> : <Circle className="h-7 w-7" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={it.done ? 'text-gray-300' : 'text-white'}>{it.text}</p>
                    {it.done && it.done_by_name && <p className="text-xs text-gray-500">{it.done_by_name} · {formatDateTime(it.done_at)}</p>}
                  </div>
                  {it.photo_url && <a href={it.photo_url} target="_blank" rel="noreferrer"><img src={it.photo_url} alt="Evidencia" className="h-12 w-12 rounded-lg object-cover" /></a>}
                  {it.requires_photo && !sent && (
                    <label className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${it.photo_url ? 'border-gray-700 text-gray-400' : 'border-amber-500/50 text-amber-200'}`}>
                      <Camera className="h-4 w-4" /> {it.photo_url ? 'Cambiar' : 'Foto'}
                      <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => photo(run, it, e.target.files?.[0])} />
                    </label>
                  )}
                </li>
              ))}
            </ul>
            {!sent && (
              <div className="mt-3 flex justify-end">
                <Button onClick={() => submit(run)} disabled={done < run.items.length}><Send className="h-4 w-4" /> Enviar checklist</Button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function History({ branchId }: { branchId: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [open, setOpen] = useState<Run | null>(null);
  useEffect(() => {
    api<{ runs: HistoryRow[] }>(`/rh/checklists/runs?branch_id=${branchId}`).then((r) => setRows(r.runs)).catch(() => setRows([]));
  }, [branchId]);
  if (!rows) return <Spinner />;
  return (
    <>
      <div className="card divide-y divide-gray-800">
        {rows.length === 0 && <p className="p-6 text-center text-sm text-gray-500">Sin historial.</p>}
        {rows.map((r) => (
          <button key={r.id} onClick={() => api<{ run: Run }>(`/rh/checklists/runs/${r.id}`).then((d) => setOpen(d.run))}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-800/40">
            <span className="w-24 text-gray-400">{r.run_date}</span>
            <span className="flex-1 text-white">{r.name}</span>
            <span className={r.status === 'enviado' ? 'text-emerald-300' : r.done < r.total ? 'text-amber-300' : 'text-gray-400'}>
              {r.status === 'enviado' ? `Enviado · ${r.submitted_by_name}` : `Sin enviar (${r.done}/${r.total})`}
            </span>
          </button>
        ))}
      </div>
      {open && (
        <Modal title={`${open.name} · ${open.run_date}`} onClose={() => setOpen(null)} wide>
          <ul className="divide-y divide-gray-800 text-sm">
            {open.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                {i.done ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : <X className="h-5 w-5 text-red-400" />}
                <span className="flex-1 text-gray-200">{i.text}<span className="block text-xs text-gray-500">{i.done_by_name ? `${i.done_by_name} · ${formatDateTime(i.done_at)}` : ''}</span></span>
                {i.photo_url && <a href={i.photo_url} target="_blank" rel="noreferrer"><img src={i.photo_url} alt="Evidencia" className="h-16 w-16 rounded-lg object-cover" /></a>}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}

function Templates() {
  const [list, setList] = useState<Template[] | null>(null);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const load = useCallback(() => { api<{ templates: Template[] }>('/rh/checklists/templates').then((r) => setList(r.templates)).catch(() => setList([])); }, []);
  useEffect(load, [load]);
  return (
    <>
      <div className="mb-3 flex justify-end"><Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo checklist</Button></div>
      {!list ? <Spinner /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.length === 0 && <p className="card p-6 text-sm text-gray-500 md:col-span-2">Sin plantillas. Ejemplos: Apertura, Cierre, Limpieza de baños.</p>}
          {list.map((t) => (
            <article key={t.id} className={`card p-4 ${t.active ? '' : 'opacity-50'}`}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-white">{t.name}</h3>
                <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(t)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
              </div>
              <ul className="mt-2 space-y-0.5 text-sm text-gray-400">
                {t.items.map((i) => <li key={i.id}>• {i.text}{i.requires_photo && <Camera className="ml-1 inline h-3.5 w-3.5 text-amber-300" />}</li>)}
              </ul>
            </article>
          ))}
        </div>
      )}
      {editing && <TemplateModal template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

function TemplateModal({ template: t, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const { me } = useAdmin();
  const [name, setName] = useState(t?.name || '');
  const [branchId, setBranchId] = useState(t?.branch_id || '');
  const [active, setActive] = useState(t?.active ?? true);
  const [items, setItems] = useState(t?.items.map((i) => ({ ...i })) || [{ id: '', text: '', requires_photo: false }]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(t ? `/rh/checklists/templates/${t.id}` : '/rh/checklists/templates', {
        method: t ? 'PATCH' : 'POST',
        body: { name, branch_id: branchId || null, active, items: items.filter((i) => i.text.trim()).map((i) => ({ id: i.id || undefined, text: i.text, requires_photo: i.requires_photo })) },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={t ? 'Editar checklist' : 'Nuevo checklist'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre"><input className="input" required maxLength={80} value={name} placeholder="Ej. Apertura" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Sucursal">
            <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Todas</option>
              {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="space-y-2">
          <span className="label">Puntos a revisar</span>
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="input flex-1" maxLength={200} value={it.text} placeholder="Ej. Encender campana" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-gray-300">
                <input type="checkbox" checked={it.requires_photo} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, requires_photo: e.target.checked } : x)))} /> Foto
              </label>
              <button type="button" className="text-gray-400 hover:text-red-300" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Quitar"><X className="h-4 w-4" /></button>
            </div>
          ))}
          <Button type="button" variant="ghost" onClick={() => setItems([...items, { id: '', text: '', requires_photo: false }])}><Plus className="h-4 w-4" /> Agregar punto</Button>
        </div>
        <label className="flex items-center gap-3 text-sm text-gray-300"><Toggle label="Activo" checked={active} onChange={setActive} /> Activo</label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
