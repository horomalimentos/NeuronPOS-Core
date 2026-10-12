import { Gift, PiggyBank, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { canManage, useAdmin } from '../restaurant/context';
import { COLORS, FREQUENCY_LABEL, STATUS_LABEL, WEEKDAYS, type Frequency, type GoalStatus, type SavingsGoal } from './types';

/** Barra de avance de un apartado. */
export function ProgressBar({ goal }: { goal: SavingsGoal }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-gray-800">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(goal.progress * 100)}%`, backgroundColor: goal.color }} />
    </div>
  );
}

/** Apartados de dinero y metas de aguinaldo (como "Fianzas Sanas" de Horom). */
export default function SavingsPage() {
  const { me } = useAdmin();
  const navigate = useNavigate();
  const manager = canManage(me.user.role);
  const [status, setStatus] = useState<GoalStatus>('activo');
  const [data, setData] = useState<{ goals: SavingsGoal[]; can_aguinaldo: boolean } | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [aguinaldo, setAguinaldo] = useState(false);
  const load = useCallback(() => {
    api<{ goals: SavingsGoal[]; can_aguinaldo: boolean }>(`/savings/goals?status=${status}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [status]);
  useEffect(load, [load]);

  const goals = data?.goals || [];
  const totalSaved = goals.reduce((s, g) => s + g.balance, 0);
  const totalTarget = goals.reduce((s, g) => s + g.target_amount, 0);

  return (
    <>
      <PageHeader
        title="Apartados"
        subtitle="Aparta dinero por cuotas para el aguinaldo, la renta o lo que venga, y ve cuánto llevas."
        actions={(
          <>
            {manager && data?.can_aguinaldo && <Button variant="secondary" onClick={() => setAguinaldo(true)}><Gift className="h-4 w-4" /> Meta de aguinaldo</Button>}
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo apartado</Button>
          </>
        )}
      />
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(['activo', 'completado', 'cancelado'] as GoalStatus[]).map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`rounded-lg px-3 py-1.5 text-sm ${status === s ? 'bg-brand/15 text-white' : 'text-gray-400 hover:text-white'}`}>
            {STATUS_LABEL[s]}s
          </button>
        ))}
        {status === 'activo' && goals.length > 0 && (
          <span className="ml-auto text-sm text-gray-400">Apartado: <b className="text-white">{formatMXN(totalSaved)}</b> de {formatMXN(totalTarget)}</span>
        )}
      </div>
      {!data ? <Spinner /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {goals.length === 0 && (
            <p className="card p-6 text-center text-sm text-gray-500 md:col-span-2">
              {status === 'activo' ? 'No tienes apartados activos. Crea uno para empezar a guardar.' : `Sin apartados ${STATUS_LABEL[status].toLowerCase()}s.`}
            </p>
          )}
          {goals.map((g) => (
            <Link key={g.id} to={`/admin/apartados/${g.id}`} className="card block p-4 transition hover:border-gray-600">
              <div className="flex items-start justify-between gap-2">
                <h3 className="flex items-center gap-2 font-semibold text-white">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: g.color }} />
                  {g.name}
                </h3>
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  {g.kind === 'aguinaldo' && <Gift className="h-3.5 w-3.5 text-amber-300" />}
                  {g.access !== 'manage' && <Users className="h-3.5 w-3.5" />}
                  {g.scope === 'personal' ? 'Personal' : g.branch_name || 'Todo el negocio'}
                </span>
              </div>
              <div className="mt-3 flex items-baseline justify-between text-sm">
                <span className="text-lg font-semibold text-white">{formatMXN(g.balance)}</span>
                <span className="text-gray-400">de {formatMXN(g.target_amount)} · {Math.round(g.progress * 100)}%</span>
              </div>
              <div className="mt-2"><ProgressBar goal={g} /></div>
              <p className="mt-2 text-xs text-gray-500">
                {g.due_date ? `Fecha límite ${formatDay(g.due_date)}${g.status === 'activo' && g.days_left !== null ? ` · faltan ${g.days_left} días` : ''}` : 'Sin fecha límite'}
                {g.frequency && ` · ${FREQUENCY_LABEL[g.frequency]} ${g.installments_done}/${g.installments_total}`}
                {g.next_installment && ` · siguiente ${formatMXN(g.next_installment.amount)} el ${formatDay(g.next_installment.due_on)}`}
                {g.access !== 'manage' && ` · de ${g.owner_name}`}
              </p>
            </Link>
          ))}
        </div>
      )}
      {creating && <GoalModal manager={manager} branches={me.branches} onClose={() => setCreating(false)} onSaved={(g) => navigate(`/admin/apartados/${g.id}`)} />}
      {aguinaldo && <AguinaldoModal branches={me.branches} onClose={() => setAguinaldo(false)} onSaved={(g) => navigate(`/admin/apartados/${g.id}`)} />}
    </>
  );
}

export function PlanFields({ frequency, weekdays, onFrequency, onWeekdays, allowNone = true }: {
  frequency: Frequency | ''; weekdays: number[]; onFrequency: (f: Frequency | '') => void; onWeekdays: (w: number[]) => void; allowNone?: boolean;
}) {
  return (
    <>
      <Field label="Cuotas">
        <select className="input" value={frequency} onChange={(e) => onFrequency(e.target.value as Frequency | '')}>
          {allowNone && <option value="">Sin cuotas (deposito cuando pueda)</option>}
          {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
        </select>
      </Field>
      {frequency === 'diaria' && (
        <div>
          <span className="label">Días que se aparta</span>
          <div className="flex gap-1">
            {WEEKDAYS.map((d) => {
              const on = weekdays.includes(d.n);
              return (
                <button key={d.n} type="button" onClick={() => onWeekdays(on ? weekdays.filter((x) => x !== d.n) : [...weekdays, d.n].sort())}
                  className={`h-9 w-9 rounded-lg text-sm font-semibold ${on ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-400'}`}>{d.label}</button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/** Crear o editar un apartado. */
export function GoalModal({ goal, manager, branches, onClose, onSaved }: {
  goal?: SavingsGoal; manager: boolean; branches: { id: string; name: string }[]; onClose: () => void; onSaved: (g: SavingsGoal) => void;
}) {
  const [form, setForm] = useState({
    name: goal?.name || '', description: goal?.description || '', color: goal?.color || COLORS[0],
    target_amount: goal ? String(goal.target_amount) : '', scope: goal?.scope || (manager ? 'negocio' : 'personal'),
    branch_id: goal?.branch_id || '', frequency: (goal?.frequency || '') as Frequency | '', weekdays: goal?.weekdays || [1, 2, 3, 4, 5, 6],
    start_date: goal?.start_date || '', due_date: goal?.due_date || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const aguinaldo = goal?.kind === 'aguinaldo';
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body = {
      name: form.name, description: form.description || null, color: form.color, target_amount: Number(form.target_amount),
      frequency: form.frequency || null, weekdays: form.weekdays, due_date: form.due_date || null,
      ...(form.start_date ? { start_date: form.start_date } : {}),
      ...(goal ? {} : { scope: form.scope, branch_id: form.scope === 'negocio' ? form.branch_id || null : null }),
    };
    if (aguinaldo) delete (body as Partial<typeof body>).due_date;
    try {
      const r = await api<{ goal: SavingsGoal }>(goal ? `/savings/goals/${goal.id}` : '/savings/goals', { method: goal ? 'PUT' : 'POST', body });
      onSaved(r.goal);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={goal ? 'Editar apartado' : 'Nuevo apartado'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required maxLength={80} placeholder="Renta de diciembre" value={form.name} onChange={set('name')} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Meta ($)"><input className="input" type="number" min="0.01" step="0.01" required value={form.target_amount} onChange={set('target_amount')} disabled={aguinaldo} /></Field>
          <Field label="Fecha límite" hint={aguinaldo ? 'El aguinaldo vence el 20 de diciembre.' : undefined}>
            <input className="input" type="date" value={form.due_date} onChange={set('due_date')} required={Boolean(form.frequency)} disabled={aguinaldo} />
          </Field>
        </div>
        {!goal && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Es de">
              <select className="input" value={form.scope} onChange={set('scope')}>
                {manager && <option value="negocio">El negocio</option>}
                <option value="personal">Solo mío</option>
              </select>
            </Field>
            {form.scope === 'negocio' && (
              <Field label="Sucursal">
                <select className="input" value={form.branch_id} onChange={set('branch_id')}>
                  <option value="">Todas</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <PlanFields frequency={form.frequency} weekdays={form.weekdays} onFrequency={(f) => setForm({ ...form, frequency: f })} onWeekdays={(w) => setForm({ ...form, weekdays: w })} />
          {form.frequency && <Field label="Empieza" hint="Vacío = hoy"><input className="input" type="date" value={form.start_date} onChange={set('start_date')} /></Field>}
        </div>
        <Field label="Nota (opcional)"><textarea className="input min-h-16" maxLength={500} value={form.description} onChange={set('description')} /></Field>
        <div>
          <span className="label">Color</span>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setForm({ ...form, color: c })} aria-label={`Color ${c}`}
                className={`h-7 w-7 rounded-full ${form.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900' : ''}`} style={{ backgroundColor: c }} />
            ))}
          </div>
        </div>
        {goal && form.frequency && <p className="text-xs text-gray-500">Al guardar se reparten de nuevo las cuotas pendientes con lo que falta.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}><PiggyBank className="h-4 w-4" /> Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function AguinaldoModal({ branches, onClose, onSaved }: { branches: { id: string; name: string }[]; onClose: () => void; onSaved: (g: SavingsGoal) => void }) {
  const thisYear = new Date().getFullYear();
  const pastDue = new Date() > new Date(thisYear, 11, 20);
  const [form, setForm] = useState({ year: String(pastDue ? thisYear + 1 : thisYear), branch_id: '', frequency: 'semanal' as Frequency | '', weekdays: [1, 2, 3, 4, 5, 6] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await api<{ goal: SavingsGoal }>('/savings/aguinaldo', {
        method: 'POST', body: { year: Number(form.year), branch_id: form.branch_id || null, frequency: form.frequency || null, weekdays: form.weekdays },
      });
      onSaved(r.goal);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Meta de aguinaldo" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-400">
          La meta es el aguinaldo que falta pagar a los empleados activos (con lo que tienes en Recursos humanos) y vence el 20 de diciembre.
          Lo que falta se reparte en cuotas desde hoy.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Año">
            <select className="input" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })}>
              {(pastDue ? [thisYear + 1] : [thisYear, thisYear + 1]).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </Field>
          <Field label="Empleados de">
            <select className="input" value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
              <option value="">Todas las sucursales</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <PlanFields frequency={form.frequency} weekdays={form.weekdays} onFrequency={(f) => setForm({ ...form, frequency: f })} onWeekdays={(w) => setForm({ ...form, weekdays: w })} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}><Gift className="h-4 w-4" /> Crear meta</Button>
        </div>
      </form>
    </Modal>
  );
}
