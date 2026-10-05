import { Award, CheckCircle2, Lock, Monitor, Plus, Users, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import { MONTH_LABEL, rhCan } from './lib';
import type { Employee, Evaluation, HistoryMonth, MonthRanking, RecognitionSettings, RecognitionTask } from './types';

type Tab = 'ranking' | 'evaluaciones' | 'tareas' | 'historial' | 'configuracion';

/** Empleado del mes: ranking, evaluaciones, tareas, historial y configuracion. */
export default function RecognitionPage() {
  const { me } = useAdmin();
  const hasRh = Boolean(me.modules.find((m) => m.code === 'rh')?.enabled);
  const now = new Date();
  const [ym, setYm] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [tab, setTab] = useState<Tab>('ranking');
  const tabs: [Tab, string][] = [['ranking', 'Ranking'], ['evaluaciones', 'Evaluaciones'], ['tareas', 'Tareas'], ['historial', 'Historial'], ['configuracion', 'Configuración']];
  return (
    <>
      <PageHeader
        title="Empleado del mes"
        subtitle="Puntaje por asistencia, puntualidad, ventas, evaluación del gerente y tareas."
        actions={<>
          {!hasRh && <Link to="/admin/empleado-del-mes/empleados"><Button variant="secondary"><Users className="h-4 w-4" /> Empleados</Button></Link>}
          <Link to="/admin/muro"><Button variant="secondary"><Monitor className="h-4 w-4" /> Ver muro</Button></Link>
        </>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 overflow-x-auto rounded-xl bg-gray-900 p-1">
          {tabs.map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-gray-700 text-white' : 'text-gray-400'}`}>{label}</button>
          ))}
        </div>
        {(tab === 'ranking' || tab === 'evaluaciones') && <MonthPicker value={ym} onChange={setYm} />}
      </div>
      {tab === 'ranking' && <RankingTab ym={ym} isAdmin={rhCan.admin(me.user.role)} />}
      {tab === 'evaluaciones' && <EvaluationsTab ym={ym} />}
      {tab === 'tareas' && <TasksTab />}
      {tab === 'historial' && <HistoryTab />}
      {tab === 'configuracion' && <SettingsTab isAdmin={rhCan.admin(me.user.role)} hasRh={hasRh} />}
    </>
  );
}

function MonthPicker({ value, onChange }: { value: { year: number; month: number }; onChange: (v: { year: number; month: number }) => void }) {
  const y = new Date().getFullYear();
  return (
    <div className="flex gap-2">
      <select className="input w-auto py-1.5" aria-label="Mes" value={value.month} onChange={(e) => onChange({ ...value, month: Number(e.target.value) })}>
        {MONTH_LABEL.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select className="input w-auto py-1.5" aria-label="Año" value={value.year} onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}>
        {[y - 1, y].map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </div>
  );
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(0)}`);

function RankingTab({ ym, isAdmin }: { ym: { year: number; month: number }; isAdmin: boolean }) {
  const [data, setData] = useState<MonthRanking | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const load = useCallback(() => {
    setData(null);
    api<MonthRanking>(`/recognition/ranking?year=${ym.year}&month=${ym.month}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [ym]);
  useEffect(load, [load]);
  const now = new Date();
  const finished = ym.year < now.getFullYear() || (ym.year === now.getFullYear() && ym.month < now.getMonth() + 1);

  async function close() {
    if (!window.confirm(`¿Cerrar ${MONTH_LABEL[ym.month - 1]} ${ym.year}? Se guardan el ranking y los ganadores; no se puede deshacer.`)) return;
    setClosing(true);
    try {
      setData(await api<MonthRanking>(`/recognition/months/${ym.year}/${ym.month}/close`, { method: 'POST' }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClosing(false);
    }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const branches = [...new Set(data.ranking.map((r) => r.branch_name))];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          {data.closed ? <span className="inline-flex items-center gap-1 text-emerald-300"><Lock className="h-4 w-4" /> Mes cerrado {data.closed_at && formatDateTime(data.closed_at)}</span> : 'Ranking en vivo (se recalcula con cada consulta).'}
          {data.modules && !data.modules.rh && ' Sin el módulo de RH no cuentan asistencia ni puntualidad.'}
          {data.modules && !data.modules.pos && ' Sin el POS no cuentan las ventas.'}
        </p>
        {isAdmin && !data.closed && finished && <Button loading={closing} onClick={close}><Award className="h-4 w-4" /> Cerrar mes y declarar ganador</Button>}
      </div>
      {data.ranking.length === 0 && <div className="card p-8 text-center text-sm text-gray-500">Sin empleados en este mes.</div>}
      {branches.map((b) => (
        <div key={b} className="card mb-4 overflow-x-auto">
          <h3 className="px-4 pt-4 text-sm font-semibold text-white">{b}</h3>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">#</th><th className="px-4 py-2 font-medium">Empleado</th>
                <th className="px-4 py-2 font-medium">Asist.</th><th className="px-4 py-2 font-medium">Puntual.</th>
                <th className="px-4 py-2 font-medium">Ventas</th><th className="px-4 py-2 font-medium">Evaluación</th>
                <th className="px-4 py-2 font-medium">Tareas</th><th className="px-4 py-2 text-right font-medium">Puntaje</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.ranking.filter((r) => r.branch_name === b).map((r) => (
                <tr key={r.employee_id} className={r.is_winner ? 'bg-amber-500/10' : ''}>
                  <td className="px-4 py-2.5 text-gray-400">{r.rank}</td>
                  <td className="px-4 py-2.5 text-white">{r.employee_name}{r.is_winner && <Award className="ml-1 inline h-4 w-4 text-amber-300" aria-label="Ganador" />}<div className="text-xs text-gray-500">{r.position}</div></td>
                  <td className="px-4 py-2.5 text-gray-300">{pct(r.components?.attendance)}</td>
                  <td className="px-4 py-2.5 text-gray-300">{pct(r.components?.punctuality)}</td>
                  <td className="px-4 py-2.5 text-gray-300">{pct(r.components?.sales)}</td>
                  <td className="px-4 py-2.5 text-gray-300">{pct(r.components?.evaluation)}</td>
                  <td className="px-4 py-2.5 text-gray-300">{pct(r.components?.tasks)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-white">{Number(r.score).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="text-xs text-gray-500">Cada componente va de 0 a 100; “—” = no aplica a ese empleado y su peso no cuenta. Empates: asistencia, puntualidad y nombre.</p>
    </>
  );
}

function EvaluationsTab({ ym }: { ym: { year: number; month: number } }) {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [draft, setDraft] = useState<Record<string, { score: string; comment: string }>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const { me } = useAdmin();
  const load = useCallback(() => {
    api<{ employees: Employee[] }>('/employees?active=1').then((r) => setEmployees(r.employees)).catch((e) => setError(errorMessage(e)));
    api<{ evaluations: Evaluation[] }>(`/recognition/evaluations?year=${ym.year}&month=${ym.month}`).then((r) => {
      setEvals(r.evaluations);
      const mine = Object.fromEntries(r.evaluations.filter((v) => v.evaluator_id === me.user.id).map((v) => [v.employee_id, { score: String(v.score), comment: v.comment || '' }]));
      setDraft(mine);
    }).catch((e) => setError(errorMessage(e)));
  }, [ym, me.user.id]);
  useEffect(load, [load]);
  async function save(e: Employee) {
    const d = draft[e.id];
    if (!d || d.score === '') return;
    setError('');
    try {
      await api('/recognition/evaluations', { method: 'PUT', body: { employee_id: e.id, year: ym.year, month: ym.month, score: Number(d.score), comment: d.comment } });
      setSaved(e.id);
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  if (!employees) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <div className="card overflow-x-auto">
      {error && <div className="p-4"><Alert>{error}</Alert></div>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
          <tr><th className="px-4 py-3 font-medium">Empleado</th><th className="px-4 py-3 font-medium">Mi calificación (0–100)</th><th className="px-4 py-3 font-medium">Comentario</th><th className="px-4 py-3 font-medium">Promedio</th><th /></tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {employees.map((e) => {
            const all = evals.filter((v) => v.employee_id === e.id);
            const avg = all.length ? all.reduce((s, v) => s + v.score, 0) / all.length : null;
            const d = draft[e.id] || { score: '', comment: '' };
            return (
              <tr key={e.id}>
                <td className="px-4 py-2.5 text-white">{e.full_name}<div className="text-xs text-gray-500">{e.branch_name}</div></td>
                <td className="px-4 py-2.5"><input className="input w-24 py-1.5" type="number" min="0" max="100" aria-label={`Calificación de ${e.full_name}`} value={d.score} onChange={(ev) => setDraft({ ...draft, [e.id]: { ...d, score: ev.target.value } })} /></td>
                <td className="px-4 py-2.5"><input className="input py-1.5" value={d.comment} onChange={(ev) => setDraft({ ...draft, [e.id]: { ...d, comment: ev.target.value } })} /></td>
                <td className="px-4 py-2.5 text-gray-300">{avg === null ? '—' : avg.toFixed(1)}{all.length > 1 && <span className="text-xs text-gray-500"> ({all.length})</span>}</td>
                <td className="px-4 py-2.5 text-right">
                  <Button variant="secondary" onClick={() => save(e)} disabled={d.score === ''}>{saved === e.id ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : 'Guardar'}</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const TASK_STATUS_STYLE = { pendiente: 'text-amber-300', completada: 'text-emerald-300', cancelada: 'text-gray-500' } as const;

function TasksTab() {
  const [tasks, setTasks] = useState<RecognitionTask[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api<{ tasks: RecognitionTask[] }>('/recognition/tasks').then((r) => setTasks(r.tasks)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    api<{ employees: Employee[] }>('/employees?active=1').then((r) => setEmployees(r.employees)).catch(() => {});
  }, [load]);
  async function act(t: RecognitionTask, action: 'complete' | 'cancel') {
    try {
      await api(`/recognition/tasks/${t.id}/${action}`, { method: 'POST' });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <>
      <div className="mb-3 flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nueva tarea</Button></div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!tasks ? <Spinner /> : tasks.length === 0 ? <div className="card p-8 text-center text-sm text-gray-500">Sin tareas. Asigna tareas con puntos que cuentan para el empleado del mes.</div> : (
        <div className="card divide-y divide-gray-800">
          {tasks.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <div className="text-white">{t.title} <span className="text-xs text-gray-500">· {t.points} pts</span></div>
                <div className="text-xs text-gray-500">{t.employee_name}{t.due_date && ` · para el ${formatDay(t.due_date)}`}{t.description && ` · ${t.description}`}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs ${TASK_STATUS_STYLE[t.status]}`}>{t.status}{t.completed_at && ` ${formatDateTime(t.completed_at)}`}</span>
                {t.status === 'pendiente' && <>
                  <button className="rounded-lg p-1.5 text-emerald-300 hover:bg-gray-800" onClick={() => act(t, 'complete')} aria-label="Completada"><CheckCircle2 className="h-4 w-4" /></button>
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => act(t, 'cancel')} aria-label="Cancelar"><XCircle className="h-4 w-4" /></button>
                </>}
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <TaskModal employees={employees} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </>
  );
}

function TaskModal({ employees, onClose, onSaved }: { employees: Employee[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ employee_id: employees[0]?.id || '', title: '', description: '', points: '10', due_date: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/recognition/tasks', { method: 'POST', body: { ...form, points: Number(form.points), due_date: form.due_date || null } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Nueva tarea" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Empleado">
          <select className="input" value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
            {employees.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
          </select>
        </Field>
        <Field label="Tarea"><input className="input" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Descripción (opcional)"><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Puntos"><input className="input" type="number" min="1" max="1000" required value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} /></Field>
          <Field label="Para el (opcional)"><input className="input" type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Asignar</Button>
        </div>
      </form>
    </Modal>
  );
}

function HistoryTab() {
  const [months, setMonths] = useState<HistoryMonth[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ months: HistoryMonth[] }>('/recognition/history').then((r) => setMonths(r.months)).catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!months) return <Spinner />;
  if (months.length === 0) return <div className="card p-8 text-center text-sm text-gray-500">Todavía no hay meses cerrados. El mes se cierra solo el día 1 (si está activado) o a mano desde el ranking.</div>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {months.map((m) => (
        <div key={`${m.year}-${m.month}`} className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-white">{MONTH_LABEL[m.month - 1]} {m.year}</h3>
            <span className="text-xs text-gray-500">{m.closed_by_name ? `Cerró ${m.closed_by_name}` : 'Cierre automático'}</span>
          </div>
          {m.winners.length === 0 ? <p className="mt-2 text-sm text-gray-500">Sin ganador.</p> : (
            <ul className="mt-2 space-y-1 text-sm">
              {m.winners.map((w) => (
                <li key={w.employee_id} className="flex justify-between gap-3">
                  <span className="text-white"><Award className="mr-1 inline h-4 w-4 text-amber-300" />{w.employee_name}</span>
                  <span className="text-gray-500">{w.branch_name} · {Number(w.score).toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
          {(m.prize_text || Number(m.prize_amount) > 0) && <p className="mt-2 text-xs text-gray-400">Premio: {[m.prize_text, Number(m.prize_amount) > 0 && formatMXN(m.prize_amount)].filter(Boolean).join(' · ')}</p>}
        </div>
      ))}
    </div>
  );
}

function SettingsTab({ isAdmin, hasRh }: { isAdmin: boolean; hasRh: boolean }) {
  const [form, setForm] = useState<Record<string, string | boolean> | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ settings: RecognitionSettings }>('/recognition/settings').then(({ settings: s }) => setForm({
      weight_attendance: String(s.weight_attendance), weight_punctuality: String(s.weight_punctuality), weight_sales: String(s.weight_sales),
      weight_evaluation: String(s.weight_evaluation), weight_tasks: String(s.weight_tasks), min_days_worked: String(s.min_days_worked),
      prize_text: s.prize_text || '', prize_amount: String(Number(s.prize_amount)), prize_to_payroll: s.prize_to_payroll, auto_close: s.auto_close,
    })).catch((e) => setError(errorMessage(e)));
  }, []);
  if (!form) return error ? <Alert>{error}</Alert> : <Spinner />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) body[k] = typeof v === 'boolean' || k === 'prize_text' ? v : Number(v);
      await api('/recognition/settings', { method: 'PUT', body });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  const w = (k: string, label: string) => (
    <Field label={label}><input className="input" type="number" min="0" max="100" disabled={!isAdmin} value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
  );
  return (
    <form onSubmit={submit} className="card space-y-5 p-5">
      {error && <Alert>{error}</Alert>}
      {saved && <Alert kind="success">Configuración guardada.</Alert>}
      <h3 className="text-sm font-semibold text-white">Pesos (relativos; 0 = no cuenta)</h3>
      <div className="grid gap-4 sm:grid-cols-5">
        {w('weight_attendance', 'Asistencia')}{w('weight_punctuality', 'Puntualidad')}{w('weight_sales', 'Ventas')}
        {w('weight_evaluation', 'Evaluación')}{w('weight_tasks', 'Tareas')}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Días trabajados mínimos para ganar"><input className="input" type="number" min="0" max="31" disabled={!isAdmin} value={String(form.min_days_worked)} onChange={(e) => setForm({ ...form, min_days_worked: e.target.value })} /></Field>
        <Field label="Premio"><input className="input" disabled={!isAdmin} value={String(form.prize_text)} onChange={(e) => setForm({ ...form, prize_text: e.target.value })} placeholder="Cena para dos, día libre…" /></Field>
        <Field label="Monto del premio ($)"><input className="input" type="number" min="0" step="0.01" disabled={!isAdmin} value={String(form.prize_amount)} onChange={(e) => setForm({ ...form, prize_amount: e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-3 text-sm text-gray-300">
        <Toggle label="Premio a nómina" checked={Boolean(form.prize_to_payroll)} disabled={!isAdmin || !hasRh} onChange={(v) => setForm({ ...form, prize_to_payroll: v })} />
        Agregar el monto como bono en la nómina{!hasRh && ' (requiere el módulo de RH)'}
      </label>
      <label className="flex items-center gap-3 text-sm text-gray-300">
        <Toggle label="Cierre automático" checked={Boolean(form.auto_close)} disabled={!isAdmin} onChange={(v) => setForm({ ...form, auto_close: v })} />
        Cerrar el mes anterior automáticamente el día 1
      </label>
      {isAdmin && <div className="flex justify-end"><Button type="submit" loading={saving}>Guardar</Button></div>}
    </form>
  );
}
