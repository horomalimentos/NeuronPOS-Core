import { ChevronLeft, ChevronRight, Copy, Moon, Paintbrush, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAdmin } from '../restaurant/context';
import { addDaysStr, shortDay } from './lib';
import type { RosterDay, RosterEmployee, RosterWeek, ShiftTemplate } from './types';

/** Lo que se aplica a un dia: un turno, descanso, horario a mano o volver al fijo. */
type Brush = { kind: 'shift'; id: string } | { kind: 'rest' } | { kind: 'clear' };

const range = (d: RosterDay) => `${d.start_time}–${d.end_time}`;

function Cell({ d }: { d: RosterDay }) {
  if (d.outside) return <span className="text-gray-700">—</span>;
  if (d.source === 'rol' && d.is_rest) return <span className="rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300">Descanso</span>;
  if (d.source === 'rol') {
    return (
      <span className="block rounded-md px-2 py-1 text-xs font-medium text-white" style={{ backgroundColor: `${d.color || '#475569'}cc` }}>
        {d.shift_name || 'A mano'}
        <span className="block font-normal opacity-90">{range(d)}</span>
      </span>
    );
  }
  if (d.source === 'fijo') return <span className="text-xs text-gray-400">{range(d)}<span className="block text-gray-600">fijo</span></span>;
  return <span className="text-xs text-gray-600">Descanso<span className="block">fijo</span></span>;
}

/** Rol semanal (modulo turnos): turno de cada empleado por dia. */
export default function ShiftsPage() {
  const { me } = useAdmin();
  const [start, setStart] = useState<string | null>(null);
  const [branch, setBranch] = useState('');
  const [data, setData] = useState<RosterWeek | null>(null);
  const [error, setError] = useState('');
  const [brush, setBrush] = useState<Brush | null>(null);
  const [editing, setEditing] = useState<{ e: RosterEmployee; d: RosterDay } | null>(null);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (start) q.set('start', start);
    if (branch) q.set('branch_id', branch);
    api<RosterWeek>(`/rh/shifts/week?${q}`)
      .then((r) => { setData(r); setError(''); if (!start) setStart(r.start); })
      .catch((e) => setError(errorMessage(e)));
  }, [start, branch]);
  useEffect(load, [load]);

  async function save(items: Record<string, unknown>[]) {
    setBusy(true);
    try {
      await api('/rh/shifts/days', { method: 'PUT', body: { items } });
      setError('');
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const apply = (b: Brush, e: RosterEmployee, d: RosterDay) => save([{
    employee_id: e.id, date: d.date,
    ...(b.kind === 'shift' ? { shift_id: b.id } : b.kind === 'rest' ? { rest: true } : { clear: true }),
  }]);

  function click(e: RosterEmployee, d: RosterDay) {
    if (d.outside || busy) return;
    if (brush) void apply(brush, e, d);
    else setEditing({ e, d });
  }

  async function copyPrevious() {
    if (!data) return;
    const from = addDaysStr(data.start, -7);
    if (!window.confirm(`¿Copiar el rol de la semana del ${shortDay(from)} a esta semana? Lo ya asignado aquí no se cambia.`)) return;
    setBusy(true);
    try {
      const r = await api<{ copied: number }>('/rh/shifts/copy-week', { method: 'POST', body: { from, to: data.start, branch_id: branch || undefined } });
      if (!r.copied) setError('La semana anterior no tiene turnos asignados (o ya estaban copiados).');
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const active = data.templates.filter((t) => t.active);
  const same = (b: Brush) => JSON.stringify(b) === JSON.stringify(brush);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-xl border border-gray-800">
          <button className="p-2 text-gray-400 hover:text-white" aria-label="Semana anterior" onClick={() => setStart(addDaysStr(data.start, -7))}><ChevronLeft className="h-4 w-4" /></button>
          <span className="px-2 text-sm text-white">{shortDay(data.start)} al {shortDay(data.end)}</span>
          <button className="p-2 text-gray-400 hover:text-white" aria-label="Semana siguiente" onClick={() => setStart(addDaysStr(data.start, 7))}><ChevronRight className="h-4 w-4" /></button>
        </div>
        <Button variant="ghost" onClick={() => setStart(null)}>Esta semana</Button>
        {me.branches.length > 1 && (
          <select className="input w-auto" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Sucursal">
            <option value="">Todas las sucursales</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={copyPrevious} loading={busy}><Copy className="h-4 w-4" /> Copiar semana anterior</Button>
          <Button variant="secondary" onClick={() => setManaging(true)}><Pencil className="h-4 w-4" /> Turnos</Button>
        </div>
      </div>

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <span className="flex items-center gap-1.5 text-xs text-gray-400"><Paintbrush className="h-4 w-4" /> Pincel:</span>
        <button onClick={() => setBrush(null)}
          className={`rounded-lg px-2.5 py-1 text-xs ${!brush ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
          Ninguno (tocar para editar)
        </button>
        {active.map((t) => (
          <button key={t.id} onClick={() => setBrush({ kind: 'shift', id: t.id })}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${same({ kind: 'shift', id: t.id }) ? 'bg-gray-700 text-white ring-1 ring-white/40' : 'text-gray-300 hover:text-white'}`}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} /> {t.name} <span className="text-gray-500">{t.start_time}–{t.end_time}</span>
          </button>
        ))}
        <button onClick={() => setBrush({ kind: 'rest' })}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${same({ kind: 'rest' }) ? 'bg-gray-700 text-white ring-1 ring-white/40' : 'text-gray-300 hover:text-white'}`}>
          <Moon className="h-3.5 w-3.5" /> Descanso
        </button>
        <button onClick={() => setBrush({ kind: 'clear' })}
          className={`rounded-lg px-2.5 py-1 text-xs ${same({ kind: 'clear' }) ? 'bg-gray-700 text-white ring-1 ring-white/40' : 'text-gray-300 hover:text-white'}`}>
          Horario fijo
        </button>
        {!active.length && <span className="text-xs text-amber-300">Crea tus turnos en “Turnos” para asignarlos con el pincel.</span>}
      </div>

      {error && <Alert>{error}</Alert>}

      {data.employees.length === 0 ? <p className="card p-8 text-center text-sm text-gray-500">No hay empleados en esta semana.</p> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">Empleado</th>
                {data.dates.map((d) => <th key={d} className="px-2 py-2 font-medium">{shortDay(d)}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.id} className="border-b border-gray-800/60 last:border-0">
                  <td className="px-3 py-2">
                    <span className="text-white">{e.full_name}</span>
                    <span className="block text-xs text-gray-500">{[e.position, me.branches.length > 1 ? e.branch_name : null].filter(Boolean).join(' · ')}</span>
                  </td>
                  {e.days.map((d) => (
                    <td key={d.date} className="px-1.5 py-1.5 align-top">
                      <button disabled={d.outside} onClick={() => click(e, d)} title={d.note || undefined}
                        className="block min-h-[44px] w-full rounded-lg p-1 text-left transition hover:bg-gray-800 disabled:cursor-default disabled:hover:bg-transparent">
                        <Cell d={d} />
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-500">Lo asignado aquí manda sobre el horario fijo en la asistencia, los retardos y la nómina. Un día sin asignar usa el horario fijo del empleado.</p>

      {editing && (
        <DayModal key={`${editing.e.id}${editing.d.date}`} employee={editing.e} day={editing.d} templates={active}
          onClose={() => setEditing(null)} onSave={async (item) => { await save([{ employee_id: editing.e.id, date: editing.d.date, ...item }]); setEditing(null); }} />
      )}
      {managing && <TemplatesModal templates={data.templates} onClose={() => { setManaging(false); load(); }} />}
    </div>
  );
}

function DayModal({ employee, day, templates, onClose, onSave }: {
  employee: RosterEmployee; day: RosterDay; templates: ShiftTemplate[];
  onClose: () => void; onSave: (item: Record<string, unknown>) => Promise<void>;
}) {
  const [startTime, setStartTime] = useState(day.start_time || '09:00');
  const [endTime, setEndTime] = useState(day.end_time || '17:00');
  const [note, setNote] = useState(day.note || '');
  const n = note.trim() || null;
  return (
    <Modal title={`${employee.full_name} · ${shortDay(day.date)}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {templates.map((t) => (
            <button key={t.id} onClick={() => void onSave({ shift_id: t.id, note: n })}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm hover:bg-gray-800 ${day.shift_id === t.id ? 'border-brand' : 'border-gray-700'}`}>
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: t.color }} />
              <span className="text-white">{t.name}</span><span className="ml-auto text-xs text-gray-400">{t.start_time}–{t.end_time}</span>
            </button>
          ))}
          <button onClick={() => void onSave({ rest: true, note: n })}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm hover:bg-gray-800 ${day.source === 'rol' && day.is_rest ? 'border-brand' : 'border-gray-700'}`}>
            <Moon className="h-4 w-4 text-gray-400" /> <span className="text-white">Descanso</span>
          </button>
          {day.source === 'rol' && (
            <button onClick={() => void onSave({ clear: true })} className="rounded-xl border border-gray-700 px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-800">
              Volver al horario fijo
            </button>
          )}
        </div>
        <div className="rounded-xl border border-gray-800 p-3">
          <p className="mb-2 text-sm text-gray-300">Horario a mano</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Entrada"><input type="time" className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
            <Field label="Salida"><input type="time" className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></Field>
            <Button onClick={() => void onSave({ start_time: startTime, end_time: endTime, note: n })} disabled={!startTime || !endTime || startTime === endTime}>Asignar</Button>
          </div>
        </div>
        <Field label="Nota (opcional)">
          <input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej. cubre a Luis" />
        </Field>
      </div>
    </Modal>
  );
}

const PALETTE = ['#3B82F6', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#EF4444', '#64748B'];

function TemplatesModal({ templates, onClose }: { templates: ShiftTemplate[]; onClose: () => void }) {
  const [list, setList] = useState(templates);
  const [form, setForm] = useState<{ id?: string; name: string; start_time: string; end_time: string; color: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const { id, ...body } = form;
      const r = await api<{ template: ShiftTemplate }>(id ? `/rh/shifts/templates/${id}` : '/rh/shifts/templates', { method: id ? 'PATCH' : 'POST', body });
      setList((l) => (id ? l.map((t) => (t.id === id ? r.template : t)) : [...l, r.template]));
      setForm(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: ShiftTemplate) {
    if (!window.confirm(`¿Quitar el turno "${t.name}"? Lo ya asignado en el rol se queda igual.`)) return;
    try {
      const r = await api<{ result: string }>(`/rh/shifts/templates/${t.id}`, { method: 'DELETE' });
      setList((l) => (r.result === 'borrado' ? l.filter((x) => x.id !== t.id) : l.map((x) => (x.id === t.id ? { ...x, active: false } : x))));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Modal title="Turnos" onClose={onClose}>
      <div className="space-y-3">
        {list.length === 0 && <p className="text-sm text-gray-500">Todavía no tienes turnos. Ej. Matutino 07:00 a 15:00.</p>}
        {list.map((t) => (
          <div key={t.id} className={`flex items-center gap-3 rounded-xl border border-gray-800 px-3 py-2 ${t.active ? '' : 'opacity-50'}`}>
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: t.color }} />
            <span className="text-sm text-white">{t.name}</span>
            <span className="text-xs text-gray-400">{t.start_time}–{t.end_time}{t.active ? '' : ' · inactivo'}</span>
            <div className="ml-auto flex gap-1">
              {t.active ? (
                <>
                  <button className="p-1.5 text-gray-400 hover:text-white" aria-label={`Editar ${t.name}`}
                    onClick={() => setForm({ id: t.id, name: t.name, start_time: t.start_time, end_time: t.end_time, color: t.color })}><Pencil className="h-4 w-4" /></button>
                  <button className="p-1.5 text-gray-400 hover:text-red-400" aria-label={`Quitar ${t.name}`} onClick={() => void remove(t)}><Trash2 className="h-4 w-4" /></button>
                </>
              ) : (
                <button className="text-xs text-gray-400 hover:text-white" onClick={async () => {
                  const r = await api<{ template: ShiftTemplate }>(`/rh/shifts/templates/${t.id}`, { method: 'PATCH', body: { active: true } });
                  setList((l) => l.map((x) => (x.id === t.id ? r.template : x)));
                }}>Reactivar</button>
              )}
            </div>
          </div>
        ))}

        {form ? (
          <div className="space-y-3 rounded-xl border border-gray-700 p-3">
            <Field label="Nombre"><input className="input" maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Matutino" /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Entrada"><input type="time" className="input" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} /></Field>
              <Field label="Salida"><input type="time" className="input" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} /></Field>
            </div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
              {PALETTE.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={form.color === c} aria-label={c} onClick={() => setForm({ ...form, color: c })}
                  className={`h-7 w-7 rounded-full ${form.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900' : ''}`} style={{ backgroundColor: c }} />
              ))}
            </div>
            <p className="text-xs text-gray-500">Si la salida es antes que la entrada, el turno termina al día siguiente.</p>
            {error && <Alert>{error}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setForm(null)}>Cancelar</Button>
              <Button onClick={submit} loading={busy} disabled={!form.name.trim() || !form.start_time || !form.end_time}>Guardar</Button>
            </div>
          </div>
        ) : (
          <>
            {error && <Alert>{error}</Alert>}
            <Button variant="secondary" onClick={() => setForm({ name: '', start_time: '07:00', end_time: '15:00', color: PALETTE[list.length % PALETTE.length] })}>
              <Plus className="h-4 w-4" /> Nuevo turno
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
