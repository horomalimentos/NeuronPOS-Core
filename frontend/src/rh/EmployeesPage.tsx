import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ROLE_LABEL, formatDay, formatMXN } from '../lib/format';
import type { Branch, User } from '../lib/types';
import { useAdmin } from '../restaurant/context';
import { DOW_LABEL, DOW_SHORT, FREQUENCY_LABEL, rhCan } from './lib';
import type { Area, Employee, Frequency, PayType, ScheduleDay } from './types';

/** Empleados: expediente, sueldo, horario semanal y NIP del checador. */
export default function EmployeesPage() {
  const { me } = useAdmin();
  const hasRh = Boolean(me.modules.find((m) => m.code === 'rh')?.enabled);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<Employee | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(() => {
    api<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch((e) => setError(errorMessage(e)));
    if (hasRh) api<{ areas: Area[] }>('/rh/areas').then((r) => setAreas(r.areas)).catch(() => {});
    api<{ users: User[] }>('/users').then((r) => setUsers(r.users)).catch(() => {});
  }, [hasRh]);
  useEffect(load, [load]);

  async function remove(e: Employee) {
    if (!window.confirm(`¿Borrar a ${e.full_name}? Si tiene historial, mejor dalo de baja.`)) return;
    try {
      await api(`/employees/${e.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const list = (employees || []).filter((e) => showInactive || e.active);
  return (
    <>
      <PageHeader
        title="Empleados"
        subtitle={hasRh ? 'Expediente, sueldo, horario y NIP del checador.' : 'Participantes del empleado del mes.'}
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo empleado</Button>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <label className="mb-3 flex items-center gap-2 text-sm text-gray-400">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar dados de baja
      </label>
      {!employees ? <Spinner /> : list.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-500">Todavía no hay empleados. Agrega el primero.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Empleado</th>
                <th className="px-4 py-3 font-medium">Sucursal</th>
                {hasRh && <th className="px-4 py-3 font-medium">Sueldo</th>}
                {hasRh && <th className="px-4 py-3 font-medium">Horario</th>}
                <th className="px-4 py-3 font-medium">Usuario</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {list.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{e.full_name}</div>
                    <div className="text-xs text-gray-500">
                      {[e.position, e.area_name, e.employee_number && `#${e.employee_number}`].filter(Boolean).join(' · ') || '—'}
                      {!e.active && ` · baja ${formatDay(e.termination_date)}`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300">{e.branch_name}</td>
                  {hasRh && (
                    <td className="px-4 py-3 text-gray-300">
                      {e.pay_type === 'por_hora' ? `${formatMXN(e.hourly_rate)}/h` : `${formatMXN(e.daily_salary)}/día`}
                      <div className="text-xs text-gray-500">{FREQUENCY_LABEL[e.payment_frequency]}</div>
                    </td>
                  )}
                  {hasRh && (
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {e.has_pin ? <span className="text-emerald-300">NIP listo</span> : <span className="text-amber-300">Sin NIP</span>}
                    </td>
                  )}
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {e.user_name ? <>{e.user_name}<div className="text-gray-600">{e.user_role && ROLE_LABEL[e.user_role]}</div></> : 'Sin acceso'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {hasRh && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setPinFor(e)} aria-label="NIP"><KeyRound className="h-4 w-4" /></button>}
                      <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(e)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                      {rhCan.admin(me.user.role) && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(e)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EmployeeModal
          employeeId={editing === 'new' ? null : editing.id}
          branches={me.branches}
          areas={areas}
          users={users}
          linked={(employees || []).filter((e) => e.user_id && (editing === 'new' || e.id !== editing.id)).map((e) => e.user_id as string)}
          hasRh={hasRh}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {pinFor && <PinModal employee={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); load(); }} />}
    </>
  );
}

const EMPTY_SCHEDULE: (ScheduleDay & { on: boolean })[] = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  day_of_week: d, start_time: '09:00', end_time: '17:00', on: d >= 1 && d <= 6,
}));

function EmployeeModal({ employeeId, branches, areas, users, linked, hasRh, onClose, onSaved }: {
  employeeId: string | null; branches: Branch[]; areas: Area[]; users: User[]; linked: string[]; hasRh: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(!employeeId);
  const [form, setForm] = useState({
    full_name: '', branch_id: branches[0]?.id || '', area_id: '', user_id: '', employee_number: '', position: '',
    pay_type: 'diario' as PayType, daily_salary: '', hourly_rate: '', payment_frequency: 'semanal' as Frequency,
    hire_date: new Date().toISOString().slice(0, 10), termination_date: '', active: true,
    nss: '', rfc: '', curp: '', phone: '', email: '', bank_name: '', bank_account: '', notes: '', pin: '',
  });
  const [schedule, setSchedule] = useState(EMPTY_SCHEDULE);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!employeeId) return;
    api<{ employee: Employee }>(`/employees/${employeeId}`).then(({ employee: e }) => {
      setForm((f) => ({
        ...f,
        full_name: e.full_name, branch_id: e.branch_id, area_id: e.area_id || '', user_id: e.user_id || '',
        employee_number: e.employee_number || '', position: e.position || '', pay_type: e.pay_type,
        daily_salary: String(Number(e.daily_salary)), hourly_rate: String(Number(e.hourly_rate)),
        payment_frequency: e.payment_frequency, hire_date: e.hire_date, termination_date: e.termination_date || '',
        active: e.active, nss: e.nss || '', rfc: e.rfc || '', curp: e.curp || '', phone: e.phone || '', email: e.email || '',
        bank_name: e.bank_name || '', bank_account: e.bank_account || '', notes: e.notes || '',
      }));
      setSchedule(EMPTY_SCHEDULE.map((d) => {
        const s = e.schedule?.find((x) => x.day_of_week === d.day_of_week);
        return s ? { ...s, on: true } : { ...d, on: false };
      }));
      setLoaded(true);
    }).catch((err) => setError(errorMessage(err)));
  }, [employeeId]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        full_name: form.full_name, branch_id: form.branch_id, user_id: form.user_id || null,
        employee_number: form.employee_number || null, position: form.position || null, hire_date: form.hire_date,
      };
      if (hasRh) {
        Object.assign(body, {
          area_id: form.area_id || null, pay_type: form.pay_type, daily_salary: Number(form.daily_salary || 0),
          hourly_rate: Number(form.hourly_rate || 0), payment_frequency: form.payment_frequency,
          termination_date: form.termination_date || null, active: form.active,
          nss: form.nss || null, rfc: form.rfc || null, curp: form.curp || null, phone: form.phone || null,
          email: form.email || null, bank_name: form.bank_name || null, bank_account: form.bank_account || null, notes: form.notes || null,
        });
      } else {
        body.active = form.active;
      }
      const days = schedule.filter((d) => d.on).map(({ day_of_week, start_time, end_time }) => ({ day_of_week, start_time, end_time }));
      if (employeeId) {
        await api(`/employees/${employeeId}`, { method: 'PATCH', body });
        if (hasRh) await api(`/employees/${employeeId}/schedule`, { method: 'PUT', body: { schedule: days } });
      } else {
        if (hasRh) body.schedule = days;
        if (hasRh && form.pin) body.pin = form.pin;
        await api('/employees', { method: 'POST', body });
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={employeeId ? 'Editar empleado' : 'Nuevo empleado'} onClose={onClose} wide>
      {!loaded ? <Spinner /> : (
        <form onSubmit={submit} className="space-y-5">
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre completo"><input className="input" required value={form.full_name} onChange={set('full_name')} /></Field>
            <Field label="Puesto"><input className="input" value={form.position} onChange={set('position')} placeholder="Mesero, cocinero…" /></Field>
            <Field label="Sucursal">
              <select className="input" value={form.branch_id} onChange={set('branch_id')}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            {hasRh && (
              <Field label="Área">
                <select className="input" value={form.area_id} onChange={set('area_id')}>
                  <option value="">Sin área</option>
                  {areas.filter((a) => a.active || a.id === form.area_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Usuario del sistema" hint="Con usuario ve sus checadas y recibos en “Mi nómina”.">
              <select className="input" value={form.user_id} onChange={set('user_id')}>
                <option value="">Sin acceso al sistema</option>
                {users.filter((u) => !linked.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_LABEL[u.role]})</option>)}
              </select>
            </Field>
            <Field label="Número de empleado" hint="Opcional; lo usa la importación de otros relojes.">
              <input className="input" value={form.employee_number} onChange={set('employee_number')} />
            </Field>
            <Field label="Fecha de ingreso"><input className="input" type="date" required value={form.hire_date} onChange={set('hire_date')} /></Field>
            {hasRh && <Field label="Fecha de baja (opcional)"><input className="input" type="date" value={form.termination_date} onChange={set('termination_date')} /></Field>}
          </div>

          {hasRh && (
            <>
              <h3 className="text-sm font-semibold text-white">Sueldo</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Tipo de pago">
                  <select className="input" value={form.pay_type} onChange={set('pay_type')}>
                    <option value="diario">Salario diario</option>
                    <option value="por_hora">Por hora</option>
                  </select>
                </Field>
                {form.pay_type === 'diario'
                  ? <Field label="Salario diario"><input className="input" type="number" min="0" step="0.01" value={form.daily_salary} onChange={set('daily_salary')} /></Field>
                  : <Field label="Tarifa por hora"><input className="input" type="number" min="0" step="0.01" value={form.hourly_rate} onChange={set('hourly_rate')} /></Field>}
                <Field label="Frecuencia de pago">
                  <select className="input" value={form.payment_frequency} onChange={set('payment_frequency')}>
                    {Object.entries(FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
              </div>

              <h3 className="text-sm font-semibold text-white">Horario semanal</h3>
              <div className="space-y-2">
                {schedule.map((d, i) => (
                  <div key={d.day_of_week} className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex w-28 items-center gap-2 text-gray-300">
                      <input type="checkbox" checked={d.on} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                      {DOW_LABEL[d.day_of_week]}
                    </label>
                    {d.on ? (
                      <>
                        <input className="input w-28 py-1.5" type="time" aria-label={`Entrada ${DOW_SHORT[d.day_of_week]}`} value={d.start_time}
                          onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
                        <span className="text-gray-500">a</span>
                        <input className="input w-28 py-1.5" type="time" aria-label={`Salida ${DOW_SHORT[d.day_of_week]}`} value={d.end_time}
                          onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
                      </>
                    ) : <span className="text-gray-500">Descanso</span>}
                  </div>
                ))}
                <p className="text-xs text-gray-500">Si la salida es antes que la entrada, el turno termina al día siguiente.</p>
              </div>

              {!employeeId && (
                <Field label="NIP del checador (4 a 6 dígitos, opcional)">
                  <input className="input w-40" inputMode="numeric" pattern="\d{4,6}" value={form.pin} onChange={set('pin')} autoComplete="off" />
                </Field>
              )}

              <details className="rounded-xl border border-gray-800 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-white">Expediente (opcional)</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field label="NSS"><input className="input" value={form.nss} onChange={set('nss')} /></Field>
                  <Field label="RFC"><input className="input" value={form.rfc} onChange={set('rfc')} /></Field>
                  <Field label="CURP"><input className="input" value={form.curp} onChange={set('curp')} /></Field>
                  <Field label="Teléfono"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
                  <Field label="Correo"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
                  <Field label="Banco"><input className="input" value={form.bank_name} onChange={set('bank_name')} /></Field>
                  <Field label="Cuenta o CLABE"><input className="input" value={form.bank_account} onChange={set('bank_account')} /></Field>
                </div>
                <div className="mt-3"><Field label="Notas"><textarea className="input" rows={2} value={form.notes} onChange={set('notes')} /></Field></div>
              </details>
            </>
          )}

          <div className="flex items-center gap-3 text-sm text-gray-300">
            <Toggle label="Activo" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Activo
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={saving}>Guardar</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function PinModal({ employee, onClose, onSaved }: { employee: Employee; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(value: string | null) {
    setSaving(true);
    setError('');
    try {
      await api(`/employees/${employee.id}/pin`, { method: 'PUT', body: { pin: value } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={`NIP de ${employee.full_name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(pin); }} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-400">El empleado lo teclea en el checador. Cambiarlo también quita el bloqueo por intentos fallidos.</p>
        <Field label="Nuevo NIP (4 a 6 dígitos)">
          <input className="input w-40 text-lg tracking-widest" inputMode="numeric" pattern="\d{4,6}" required autoFocus value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
        </Field>
        <div className="flex justify-between gap-2 pt-2">
          {employee.has_pin ? <Button type="button" variant="ghost" onClick={() => save(null)} disabled={saving}>Quitar NIP</Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={saving}>Guardar NIP</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
