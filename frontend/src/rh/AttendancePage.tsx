import { ChevronDown, ChevronRight, History, Pencil, Plus, ShieldCheck, Upload, XCircle } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import { DAY_STATUS_LABEL, DAY_STATUS_STYLE, hours, inZone, rhCan, shortDay, todayStr } from './lib';
import type { AttendanceDay, AuditRow, Employee, EmployeeAttendance, TimeEntry } from './types';

const SOURCE_LABEL = { kiosco: 'Kiosco', manual: 'Manual', importado: 'Importada' } as const;

/** Asistencia: incidencias por empleado y checadas con correcciones auditadas. */
export default function AttendancePage() {
  const { me } = useAdmin();
  const [from, setFrom] = useState(todayStr(-13));
  const [to, setTo] = useState(todayStr());
  const [branchId, setBranchId] = useState('');
  const [tab, setTab] = useState<'incidencias' | 'checadas'>('incidencias');
  const [rows, setRows] = useState<EmployeeAttendance[] | null>(null);
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [justify, setJustify] = useState<{ employee: EmployeeAttendance; day: AttendanceDay } | null>(null);
  const [entryModal, setEntryModal] = useState<TimeEntry | 'new' | null>(null);
  const [voiding, setVoiding] = useState<TimeEntry | null>(null);
  const [auditOf, setAuditOf] = useState<TimeEntry | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    const q = `from=${from}&to=${to}${branchId ? `&branch_id=${branchId}` : ''}`;
    setError('');
    api<{ employees: EmployeeAttendance[] }>(`/rh/attendance?${q}`).then((r) => setRows(r.employees)).catch((e) => setError(errorMessage(e)));
    api<{ entries: TimeEntry[] }>(`/rh/time-entries?${q}`).then((r) => setEntries(r.entries)).catch((e) => setError(errorMessage(e)));
  }, [from, to, branchId]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
  }, []);

  return (
    <>
      <PageHeader
        title="Asistencia"
        subtitle="Retardos y faltas se calculan con el horario de cada empleado y la tolerancia configurada."
        actions={<>
          {rhCan.admin(me.user.role) && <Button variant="secondary" onClick={() => setImporting(true)}><Upload className="h-4 w-4" /> Importar</Button>}
          <Button onClick={() => setEntryModal('new')}><Plus className="h-4 w-4" /> Checada manual</Button>
        </>}
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Desde"><input className="input py-1.5" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><input className="input py-1.5" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Sucursal">
          <select className="input py-1.5" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Todas</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <div className="ml-auto flex gap-1 rounded-xl bg-gray-900 p-1">
          {(['incidencias', 'checadas'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-gray-700 text-white' : 'text-gray-400'}`}>
              {t === 'incidencias' ? 'Por empleado' : 'Checadas'}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      {tab === 'incidencias' && (!rows ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Empleado</th>
                <th className="px-4 py-3 font-medium">Días trabajados</th>
                <th className="px-4 py-3 font-medium">Horas</th>
                <th className="px-4 py-3 font-medium">Retardos</th>
                <th className="px-4 py-3 font-medium">Faltas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Sin empleados en este rango.</td></tr>}
              {rows.map((r) => (
                <Fragment key={r.employee_id}>
                  <tr className="cursor-pointer hover:bg-gray-800/40" onClick={() => setOpen(open === r.employee_id ? null : r.employee_id)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium text-white">
                        {open === r.employee_id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {r.full_name}
                      </div>
                      <div className="pl-6 text-xs text-gray-500">{r.branch_name}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{r.summary.days_worked} / {r.summary.days_scheduled}</td>
                    <td className="px-4 py-3 text-gray-300">{hours(r.summary.minutes_worked)}</td>
                    <td className={`px-4 py-3 ${r.summary.tardies ? 'text-amber-300' : 'text-gray-400'}`}>
                      {r.summary.tardies}{r.summary.tardies_justified ? <span className="text-xs text-gray-500"> (+{r.summary.tardies_justified} just.)</span> : null}
                    </td>
                    <td className={`px-4 py-3 ${r.summary.absences ? 'text-red-300' : 'text-gray-400'}`}>
                      {r.summary.absences}{r.summary.absences_justified ? <span className="text-xs text-gray-500"> (+{r.summary.absences_justified} just.)</span> : null}
                    </td>
                  </tr>
                  {open === r.employee_id && (
                    <tr>
                      <td colSpan={5} className="bg-gray-950/50 px-4 py-3">
                        <DayTable days={r.days} onJustify={(day) => setJustify({ employee: r, day })} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {tab === 'checadas' && (!entries ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Empleado</th>
                <th className="px-4 py-3 font-medium">Tipo</th>
                <th className="px-4 py-3 font-medium">Fecha y hora</th>
                <th className="px-4 py-3 font-medium">Origen</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {entries.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Sin checadas en este rango.</td></tr>}
              {entries.map((t) => {
                const local = inZone(t.occurred_at, t.timezone);
                return (
                  <tr key={t.id} className={t.voided ? 'opacity-50' : ''}>
                    <td className="px-4 py-2.5 text-white">{t.employee_name}<div className="text-xs text-gray-500">{t.branch_name}</div></td>
                    <td className={`px-4 py-2.5 ${t.kind === 'entrada' ? 'text-emerald-300' : 'text-sky-300'}`}>{t.kind === 'entrada' ? 'Entrada' : 'Salida'}{t.voided && <span className="text-red-300"> · anulada</span>}</td>
                    <td className="px-4 py-2.5 text-gray-300">{shortDay(local.date)} · {local.time}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-400">
                      {SOURCE_LABEL[t.source]}{t.created_by_name && t.source === 'manual' ? ` · ${t.created_by_name}` : ''}
                      {t.corrections > 0 && <span className="ml-1 text-amber-300">· {t.corrections} corrección(es)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        {t.corrections > 0 && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setAuditOf(t)} aria-label="Historial"><History className="h-4 w-4" /></button>}
                        {!t.voided && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEntryModal(t)} aria-label="Corregir"><Pencil className="h-4 w-4" /></button>}
                        {!t.voided && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => setVoiding(t)} aria-label="Anular"><XCircle className="h-4 w-4" /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {justify && <JustifyModal {...justify} onClose={() => setJustify(null)} onSaved={() => { setJustify(null); load(); }} />}
      {entryModal && <EntryModal entry={entryModal === 'new' ? null : entryModal} employees={employees.filter((e) => e.active)} onClose={() => setEntryModal(null)} onSaved={() => { setEntryModal(null); load(); }} />}
      {voiding && <VoidModal entry={voiding} onClose={() => setVoiding(null)} onSaved={() => { setVoiding(null); load(); }} />}
      {auditOf && <AuditModal entry={auditOf} onClose={() => setAuditOf(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onSaved={() => { setImporting(false); load(); }} />}
    </>
  );
}

export function DayTable({ days, onJustify }: { days: AttendanceDay[]; onJustify?: (d: AttendanceDay) => void }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-gray-500">
        <tr>
          <th className="py-1.5 pr-3 font-medium">Día</th>
          <th className="py-1.5 pr-3 font-medium">Horario</th>
          <th className="py-1.5 pr-3 font-medium">Entrada</th>
          <th className="py-1.5 pr-3 font-medium">Trabajado</th>
          <th className="py-1.5 pr-3 font-medium">Estado</th>
          {onJustify && <th />}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-800/60">
        {days.map((d) => (
          <tr key={d.date}>
            <td className="py-1.5 pr-3 text-gray-300">{shortDay(d.date)}</td>
            <td className="py-1.5 pr-3 text-gray-400">{d.scheduled_start ? `${d.scheduled_start}–${d.scheduled_end}` : '—'}</td>
            <td className="py-1.5 pr-3 text-gray-300">{d.first_in || '—'}</td>
            <td className="py-1.5 pr-3 text-gray-300">{d.minutes_worked ? hours(d.minutes_worked) : '—'}{d.incomplete && <span className="text-amber-300"> · sin salida</span>}</td>
            <td className="py-1.5 pr-3">
              <span className={DAY_STATUS_STYLE[d.status]}>{d.holiday_name || DAY_STATUS_LABEL[d.status]}</span>
              {d.tardy && <span className={d.tardy_justified ? 'text-sky-300' : 'text-amber-300'}> · retardo {d.late_minutes} min{d.tardy_justified && ' (justificado)'}</span>}
              {d.overtime_minutes > 0 && <span className="text-violet-300"> · {hours(d.overtime_minutes)} extra</span>}
              {d.note && <div className="text-gray-500">“{d.note}”</div>}
            </td>
            {onJustify && (
              <td className="py-1.5 text-right">
                {((d.status === 'falta') || (d.tardy && !d.tardy_justified)) && (
                  <button className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sky-300 hover:bg-gray-800" onClick={() => onJustify(d)}>
                    <ShieldCheck className="h-3.5 w-3.5" /> Justificar
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JustifyModal({ employee, day, onClose, onSaved }: { employee: EmployeeAttendance; day: AttendanceDay; onClose: () => void; onSaved: () => void }) {
  const kind = day.status === 'falta' ? 'falta' : 'retardo';
  const [note, setNote] = useState('');
  const [withPay, setWithPay] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/rh/justifications', { method: 'POST', body: { employee_id: employee.employee_id, date: day.date, kind, note, with_pay: withPay } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={`Justificar ${kind} · ${employee.full_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-400">{shortDay(day.date)}{kind === 'retardo' ? ` · llegó ${day.late_minutes} min tarde` : ' · sin checada'}. Justificado no se descuenta.</p>
        <Field label="Motivo"><textarea className="input" rows={2} required value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {kind === 'falta' && (
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <Toggle label="Con goce de sueldo" checked={withPay} onChange={setWithPay} /> Con goce de sueldo (se paga el día)
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Justificar</Button>
        </div>
      </form>
    </Modal>
  );
}

function EntryModal({ entry, employees, onClose, onSaved }: { entry: TimeEntry | null; employees: Employee[]; onClose: () => void; onSaved: () => void }) {
  const local = entry ? inZone(entry.occurred_at, entry.timezone) : { date: todayStr(), time: '09:00' };
  const [form, setForm] = useState({ employee_id: entry?.employee_id || employees[0]?.id || '', kind: entry?.kind || 'entrada', date: local.date, time: local.time, reason: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (entry) await api(`/rh/time-entries/${entry.id}`, { method: 'PATCH', body: { kind: form.kind, date: form.date, time: form.time, reason: form.reason } });
      else await api('/rh/time-entries', { method: 'POST', body: form });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={entry ? `Corregir checada · ${entry.employee_name}` : 'Checada manual'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!entry && (
          <Field label="Empleado">
            <select className="input" value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
              {employees.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Tipo">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'entrada' | 'salida' })}>
              <option value="entrada">Entrada</option>
              <option value="salida">Salida</option>
            </select>
          </Field>
          <Field label="Fecha"><input className="input" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="Hora"><input className="input" type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></Field>
        </div>
        <Field label="Motivo (queda en la bitácora)"><input className="input" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Olvidó checar, falla del kiosco…" /></Field>
        <p className="text-xs text-gray-500">La hora es la de la sucursal del empleado.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({ entry, onClose, onSaved }: { entry: TimeEntry; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api(`/rh/time-entries/${entry.id}/void`, { method: 'POST', body: { reason } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Anular checada" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-400">{entry.employee_name} · {entry.kind} · {formatDateTime(entry.occurred_at)}. La checada no se borra: queda anulada con su motivo.</p>
        <Field label="Motivo"><input className="input" required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="danger" loading={saving}>Anular</Button>
        </div>
      </form>
    </Modal>
  );
}

function AuditModal({ entry, onClose }: { entry: TimeEntry; onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ audit: AuditRow[] }>(`/rh/time-entries/${entry.id}/audit`).then((r) => setRows(r.audit)).catch((e) => setError(errorMessage(e)));
  }, [entry.id]);
  const fmt = (s: AuditRow['before']) => (s ? `${s.kind} ${(() => { const l = inZone(s.occurred_at, entry.timezone); return `${shortDay(l.date)} ${l.time}`; })()}${s.voided ? ' (anulada)' : ''}` : '—');
  return (
    <Modal title={`Bitácora · ${entry.employee_name}`} onClose={onClose}>
      {error && <Alert>{error}</Alert>}
      {!rows ? <Spinner /> : (
        <ul className="space-y-3 text-sm">
          {rows.map((a) => (
            <li key={a.id} className="rounded-xl border border-gray-800 p-3">
              <div className="flex justify-between text-xs text-gray-500"><span className="font-semibold uppercase text-gray-300">{a.action}</span><span>{a.user_name} · {formatDateTime(a.created_at)}</span></div>
              <div className="mt-1 text-gray-300">“{a.reason}”</div>
              <div className="mt-1 text-xs text-gray-500">{fmt(a.before)} → {fmt(a.after)}</div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ImportModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ imported: number; duplicates: number; rejected: { index: number; reason: string }[] } | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Una checada por renglon: numero_de_empleado,fecha_hora_ISO[,entrada|salida]
      const events = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [employee_number, occurred_at, kind] = l.split(/[,;\t]/).map((x) => x.trim());
        return { employee_number, occurred_at, ...(kind ? { kind } : {}) };
      });
      setResult(await api('/rh/time-entries/import', { method: 'POST', body: { format: 'generico', events } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Importar checadas de otro reloj" onClose={result ? onSaved : onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-400">
          Una checada por renglón: <code className="text-gray-300">número de empleado, fecha y hora ISO, entrada|salida (opcional)</code>.
          Las repetidas se omiten. Para conectar un reloj de otra marca se agrega un adaptador en el servidor.
        </p>
        <textarea className="input font-mono text-xs" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'101,2026-09-14T09:02:00-06:00,entrada\n101,2026-09-14T17:05:00-06:00,salida'} />
        {result && (
          <Alert kind={result.rejected.length ? 'warning' : 'success'}>
            {result.imported} importada(s), {result.duplicates} repetida(s){result.rejected.length ? `, ${result.rejected.length} rechazada(s): ${result.rejected.map((r) => `renglón ${r.index + 1} (${r.reason})`).join(', ')}` : ''}.
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={result ? onSaved : onClose}>Cerrar</Button>
          <Button type="submit" loading={saving}>Importar</Button>
        </div>
      </form>
    </Modal>
  );
}
