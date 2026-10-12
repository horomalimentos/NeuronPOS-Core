import {
  ArrowDownCircle, ArrowLeft, ArrowUpCircle, Ban, CheckCircle2, Circle, Gift, Pencil, RefreshCw, Share2, Trash2, UserMinus,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ROLE_LABEL, formatDay, formatMXN } from '../lib/format';
import type { Role } from '../lib/types';
import { canManage, useAdmin } from '../restaurant/context';
import { GoalModal, ProgressBar } from './SavingsPage';
import { FREQUENCY_LABEL, STATUS_LABEL, type AguinaldoBreakdown, type Installment, type Movement, type SavingsGoal, type Share } from './types';

interface Detail { goal: SavingsGoal; movements: Movement[]; installments: Installment[]; shares: Share[]; aguinaldo: AguinaldoBreakdown | null }

export default function SavingsDetailPage() {
  const { id } = useParams();
  const { me } = useAdmin();
  const navigate = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [movement, setMovement] = useState<'deposito' | 'retiro' | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [showAllInstallments, setShowAllInstallments] = useState(false);

  const load = useCallback(() => {
    api<Detail>(`/savings/goals/${id}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await fn(); load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const { goal, installments, movements, shares, aguinaldo } = data;
  const canEdit = goal.access !== 'view' && goal.status !== 'cancelado';
  const manage = goal.access === 'manage';
  const pending = installments.filter((i) => !i.done);
  const visibleInstallments = showAllInstallments ? installments : [...installments.filter((i) => i.done).slice(-3), ...pending.slice(0, 8)];

  const setStatus = (status: string) => run(() => api(`/savings/goals/${goal.id}`, { method: 'PUT', body: { status } }));
  const remove = () => {
    if (!confirm(`¿Borrar "${goal.name}"?`)) return;
    void run(async () => {
      await api(`/savings/goals/${goal.id}`, { method: 'DELETE' });
      navigate('/admin/apartados');
    });
  };

  return (
    <>
      <Link to="/admin/apartados" className="mb-3 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Apartados</Link>
      <PageHeader
        title={goal.name}
        subtitle={(
          <>
            {goal.kind === 'aguinaldo' && <Gift className="mr-1 inline h-4 w-4 text-amber-300" />}
            {goal.scope === 'personal' ? `Personal de ${goal.owner_name}` : goal.branch_name || 'Todo el negocio'}
            {goal.status !== 'activo' && ` · ${STATUS_LABEL[goal.status]}`}
            {goal.access === 'view' && ' · solo consulta'}
          </>
        )}
        actions={manage && (
          <>
            <Button variant="secondary" onClick={() => setSharing(true)}><Share2 className="h-4 w-4" /> Compartir</Button>
            {goal.status !== 'cancelado' && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Editar</Button>}
          </>
        )}
      />
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}

      <div className="card mb-6 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-sm text-gray-400">Apartado</p>
            <p className="text-3xl font-semibold text-white">{formatMXN(goal.balance)}</p>
          </div>
          <div className="text-right text-sm text-gray-400">
            <p>Meta {formatMXN(goal.target_amount)} · {Math.round(goal.progress * 100)}%</p>
            <p>{goal.missing > 0 ? <>Faltan <b className="text-white">{formatMXN(goal.missing)}</b></> : <b className="text-emerald-300">¡Meta cumplida!</b>}</p>
          </div>
        </div>
        <div className="mt-3"><ProgressBar goal={goal} /></div>
        <p className="mt-2 text-xs text-gray-500">
          {goal.due_date ? `Fecha límite ${formatDay(goal.due_date)}${goal.status === 'activo' && goal.days_left !== null ? ` · faltan ${goal.days_left} días` : ''}` : 'Sin fecha límite'}
          {goal.frequency && ` · cuotas ${FREQUENCY_LABEL[goal.frequency].toLowerCase()}s`}
          {goal.description && ` · ${goal.description}`}
        </p>
        {canEdit && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => setMovement('deposito')}><ArrowDownCircle className="h-4 w-4" /> Depositar</Button>
            <Button variant="secondary" onClick={() => setMovement('retiro')} disabled={goal.balance <= 0}><ArrowUpCircle className="h-4 w-4" /> Retirar</Button>
            {manage && goal.status === 'activo' && goal.missing <= 0 && <Button variant="secondary" onClick={() => void setStatus('completado')}><CheckCircle2 className="h-4 w-4" /> Marcar completado</Button>}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {goal.frequency && (
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-white">Cuotas <span className="text-sm font-normal text-gray-500">{goal.installments_done} de {goal.installments_total}</span></h2>
              {manage && goal.status === 'activo' && (
                <button className="flex items-center gap-1 text-xs text-gray-400 hover:text-white" disabled={busy} title="Repartir lo que falta en las cuotas pendientes"
                  onClick={() => void run(() => api(`/savings/goals/${goal.id}/replan`, { method: 'POST' }))}>
                  <RefreshCw className="h-3.5 w-3.5" /> Repartir de nuevo
                </button>
              )}
            </div>
            {installments.length === 0 && <p className="text-sm text-gray-500">Sin cuotas pendientes.</p>}
            <ul className="divide-y divide-gray-800">
              {visibleInstallments.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
                  <button disabled={!canEdit || busy} onClick={() => void run(() => api(`/savings/installments/${i.id}`, { method: 'PATCH', body: { done: !i.done } }))}
                    aria-label={i.done ? 'Desmarcar cuota' : 'Marcar cuota como apartada'} className="disabled:cursor-default">
                    {i.done ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : <Circle className="h-5 w-5 text-gray-600" />}
                  </button>
                  <span className={`flex-1 ${i.done ? 'text-gray-500' : 'text-gray-200'}`}>{formatDay(i.due_on)}</span>
                  <span className={i.done ? 'text-gray-500 line-through' : 'font-semibold text-white'}>{formatMXN(i.amount)}</span>
                </li>
              ))}
            </ul>
            {installments.length > visibleInstallments.length && (
              <button className="mt-2 text-xs text-gray-400 hover:text-white" onClick={() => setShowAllInstallments(true)}>Ver las {installments.length} cuotas</button>
            )}
          </section>
        )}

        <section className="card p-4">
          <h2 className="mb-3 font-semibold text-white">Movimientos</h2>
          {movements.length === 0 && <p className="text-sm text-gray-500">Todavía no hay movimientos.</p>}
          <ul className="divide-y divide-gray-800">
            {movements.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
                {m.kind === 'deposito' ? <ArrowDownCircle className="h-4 w-4 text-emerald-400" /> : <ArrowUpCircle className="h-4 w-4 text-red-400" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-gray-200">{m.notes || (m.kind === 'deposito' ? 'Depósito' : 'Retiro')}</p>
                  <p className="text-xs text-gray-500">{formatDay(m.occurred_on)}{m.created_by_name && ` · ${m.created_by_name}`}</p>
                </div>
                <span className={m.kind === 'deposito' ? 'font-semibold text-emerald-300' : 'font-semibold text-red-300'}>
                  {m.kind === 'retiro' ? '−' : '+'}{formatMXN(m.amount)}
                </span>
                {canEdit && (
                  <button className="rounded p-1 text-gray-500 hover:text-red-300" disabled={busy} aria-label="Borrar movimiento"
                    onClick={() => { if (confirm('¿Borrar este movimiento?')) void run(() => api(`/savings/movements/${m.id}`, { method: 'DELETE' })); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {aguinaldo && (
          <section className="card p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-white">Aguinaldo {aguinaldo.year} por empleado</h2>
              {manage && goal.status === 'activo' && (
                <Button variant="secondary" loading={busy} onClick={() => void run(() => api(`/savings/goals/${goal.id}/recalculate`, { method: 'POST' }))}>
                  <RefreshCw className="h-4 w-4" /> Recalcular meta
                </Button>
              )}
            </div>
            <p className="mb-2 text-xs text-gray-500">Con los empleados activos de hoy. Recalcula si hubo altas, bajas, aumentos o ya pagaste a alguien.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-gray-500">
                  <tr><th className="py-1">Empleado</th><th>Sucursal</th><th className="text-right">Días</th><th className="text-right">Monto</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {aguinaldo.employees.map((e) => (
                    <tr key={e.employee_id} className={e.paid ? 'text-gray-500' : 'text-gray-200'}>
                      <td className="py-1.5">{e.full_name}{e.paid && ' · ya pagado'}</td>
                      <td>{e.branch_name}</td>
                      <td className="text-right">{e.days_counted}</td>
                      <td className="text-right">{formatMXN(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold text-white"><td className="pt-2" colSpan={3}>Por pagar</td><td className="pt-2 text-right">{formatMXN(aguinaldo.total)}</td></tr></tfoot>
              </table>
            </div>
          </section>
        )}
      </div>

      {manage && (
        <div className="mt-6 flex flex-wrap gap-2">
          {goal.status === 'cancelado' || goal.status === 'completado'
            ? <Button variant="secondary" onClick={() => void setStatus('activo')}>Reactivar</Button>
            : <Button variant="ghost" onClick={() => { if (confirm('¿Cancelar este apartado? Se conservan sus movimientos.')) void setStatus('cancelado'); }}><Ban className="h-4 w-4" /> Cancelar apartado</Button>}
          {movements.length === 0 && <Button variant="ghost" onClick={remove}><Trash2 className="h-4 w-4" /> Borrar</Button>}
        </div>
      )}

      {movement && <MovementModal goal={goal} kind={movement} onClose={() => setMovement(null)} onSaved={() => { setMovement(null); load(); }} />}
      {editing && (
        <GoalModal goal={goal} manager={canManage(me.user.role)} branches={me.branches}
          onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      )}
      {sharing && <ShareModal goal={goal} shares={shares} onClose={() => setSharing(false)} onChanged={load} />}
    </>
  );
}

function MovementModal({ goal, kind, onClose, onSaved }: { goal: SavingsGoal; kind: 'deposito' | 'retiro'; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ amount: kind === 'deposito' && goal.next_installment ? String(goal.next_installment.amount) : '', notes: '', occurred_on: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(`/savings/goals/${goal.id}/movements`, {
        method: 'POST', body: { kind, amount: Number(form.amount), notes: form.notes || null, ...(form.occurred_on ? { occurred_on: form.occurred_on } : {}) },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={kind === 'deposito' ? 'Depositar' : 'Retirar'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {kind === 'retiro' && <p className="text-sm text-gray-400">Hay {formatMXN(goal.balance)} apartados.</p>}
        {kind === 'deposito' && goal.frequency && <p className="text-sm text-gray-400">Para marcar una cuota usa la lista de cuotas. Esto es un depósito extra: las cuotas pendientes se ajustan a lo que falta.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Monto ($)"><input className="input" type="number" min="0.01" step="0.01" required autoFocus value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label="Fecha" hint="Vacío = hoy"><input className="input" type="date" value={form.occurred_on} onChange={(e) => setForm({ ...form, occurred_on: e.target.value })} /></Field>
        </div>
        <Field label="Nota (opcional)"><input className="input" maxLength={300} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>{kind === 'deposito' ? 'Depositar' : 'Retirar'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ShareModal({ goal, shares, onClose, onChanged }: { goal: SavingsGoal; shares: Share[]; onClose: () => void; onChanged: () => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; role: Role }[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<{ people: { id: string; name: string; role: Role }[] }>('/savings/people').then((r) => setPeople(r.people)).catch(() => {}); }, []);
  const available = people.filter((p) => p.id !== goal.owner_id && !shares.some((s) => s.user_id === p.id));
  const put = (userId: string, canEdit: boolean) => api(`/savings/goals/${goal.id}/shares/${userId}`, { method: 'PUT', body: { can_edit: canEdit } })
    .then(onChanged).catch((e) => setError(errorMessage(e)));
  const del = (userId: string) => api(`/savings/goals/${goal.id}/shares/${userId}`, { method: 'DELETE' }).then(onChanged).catch((e) => setError(errorMessage(e)));
  return (
    <Modal title="Compartir apartado" onClose={onClose}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2">
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Persona">
            <option value="">Elige a alguien del equipo</option>
            {available.map((p) => <option key={p.id} value={p.id}>{p.name} · {ROLE_LABEL[p.role] || p.role}</option>)}
          </select>
          <Button disabled={!pick} onClick={() => { void put(pick, false); setPick(''); }}>Agregar</Button>
        </div>
        {shares.length === 0 ? <p className="text-sm text-gray-500">Aún no lo compartes con nadie.</p> : (
          <ul className="divide-y divide-gray-800">
            {shares.map((s) => (
              <li key={s.user_id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1 text-gray-200">{s.name} <span className="text-gray-500">· {ROLE_LABEL[s.role as Role] || s.role}</span></span>
                <span className="text-xs text-gray-400">{s.can_edit ? 'Puede registrar' : 'Solo consulta'}</span>
                <Toggle checked={s.can_edit} onChange={(v) => void put(s.user_id, v)} label="Puede registrar movimientos" />
                <button className="rounded p-1 text-gray-500 hover:text-red-300" onClick={() => void del(s.user_id)} aria-label="Quitar acceso"><UserMinus className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Listo</Button></div>
      </div>
    </Modal>
  );
}
