import { CheckCircle2, ChevronDown, ChevronRight, Radio, Undo2, XCircle } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import { CLAIM_KIND_LABEL, DAY_STATUS_LABEL, FREQUENCY_LABEL, hours, rhCan, shortDay } from './lib';
import type { AguinaldoRow, ClaimStatus, LiveItem, PayrollClaim } from './types';

const CLAIM_STATUS: Record<ClaimStatus, { label: string; tone: string }> = {
  pendiente: { label: 'Pendiente', tone: 'bg-amber-500/15 text-amber-300' },
  resuelta: { label: 'Resuelta', tone: 'bg-emerald-500/15 text-emerald-300' },
  rechazada: { label: 'Rechazada', tone: 'bg-gray-700 text-gray-300' },
};

export function ClaimBadge({ status }: { status: ClaimStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CLAIM_STATUS[status].tone}`}>{CLAIM_STATUS[status].label}</span>;
}

/** Prenomina en vivo: lo que va del periodo en curso de cada empleado (no se guarda). */
export function LiveSection() {
  const [data, setData] = useState<{ today: string; items: LiveItem[]; pending_claims: number } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api<{ today: string; items: LiveItem[]; pending_claims: number }>('/rh/payroll/live').then(setData).catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <div className="mb-6"><Alert>{error}</Alert></div>;
  if (!data) return <div className="mb-6"><Spinner label="Calculando la prenómina en vivo…" /></div>;
  const total = data.items.reduce((s, i) => s + (i.net ?? 0), 0);
  return (
    <section className="card mb-6 overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2 className="flex items-center gap-2 font-semibold text-white"><Radio className="h-4 w-4 text-emerald-400" /> Periodo en curso (en vivo)</h2>
        <span className="text-sm text-gray-400">Neto estimado a hoy: <b className="text-white">{formatMXN(total)}</b></span>
      </div>
      <p className="px-4 pb-2 text-xs text-gray-500">Con la asistencia hasta hoy ({formatDay(data.today)}). Cambia con cada checada; no se guarda hasta que generes el periodo.</p>
      {data.items.length === 0 ? <p className="p-4 text-sm text-gray-500">No hay empleados activos.</p> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-2 font-medium">Empleado</th>
              <th className="px-4 py-2 font-medium">Periodo</th>
              <th className="px-4 py-2 font-medium">Trabajó</th>
              <th className="px-4 py-2 font-medium">Faltas / retardos</th>
              <th className="px-4 py-2 text-right font-medium">Neto a hoy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {data.items.map((i) => (
              <Fragment key={i.employee_id}>
                <tr className="cursor-pointer hover:bg-gray-800/40" onClick={() => setOpen(open === i.employee_id ? null : i.employee_id)}>
                  <td className="px-4 py-2.5 text-white">
                    <span className="inline-flex items-center gap-1">{open === i.employee_id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{i.full_name}</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-400">{shortDay(i.start_date)} al {shortDay(i.end_date)} · {FREQUENCY_LABEL[i.frequency]}</td>
                  {i.no_salary ? <td colSpan={3} className="px-4 py-2.5 text-xs text-amber-300">Sin salario configurado</td> : (
                    <>
                      <td className="px-4 py-2.5 text-gray-300">{i.days_worked} días · {hours(i.minutes_worked ?? 0)}</td>
                      <td className="px-4 py-2.5 text-gray-300">{i.absences} / {i.tardies}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-white">{formatMXN(i.net)}</td>
                    </>
                  )}
                </tr>
                {open === i.employee_id && !i.no_salary && (
                  <tr>
                    <td colSpan={5} className="bg-gray-900/60 px-4 py-3">
                      <div className="grid gap-4 md:grid-cols-2">
                        <ul className="space-y-0.5 text-xs">
                          {i.days?.map((d) => (
                            <li key={d.date} className="flex justify-between gap-2">
                              <span className="text-gray-400">{shortDay(d.date)}{d.shift_name ? ` · ${d.shift_name}` : ''}</span>
                              <span className={d.status === 'falta' ? 'text-red-300' : d.tardy ? 'text-amber-300' : 'text-gray-300'}>
                                {DAY_STATUS_LABEL[d.status] ?? d.status}{d.first_in ? ` ${d.first_in}` : ''}{d.tardy ? ` (+${d.late_minutes} min)` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <ul className="space-y-0.5 text-xs">
                          {i.lines?.map((l, n) => (
                            <li key={n} className="flex justify-between gap-2">
                              <span className="text-gray-400">{l.concept}</span>
                              <span className={l.kind === 'deduccion' ? 'text-red-300' : 'text-gray-200'}>{l.kind === 'deduccion' ? '-' : ''}{formatMXN(l.amount)}</span>
                            </li>
                          ))}
                          <li className="flex justify-between gap-2 border-t border-gray-800 pt-1 font-semibold text-white"><span>Neto</span><span>{formatMXN(i.net)}</span></li>
                        </ul>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Aclaraciones de los empleados sobre su asistencia o sus recibos. */
export function ClaimsPage() {
  const [status, setStatus] = useState<ClaimStatus | ''>('pendiente');
  const [data, setData] = useState<{ claims: PayrollClaim[]; pending_count: number } | null>(null);
  const [error, setError] = useState('');
  const [answering, setAnswering] = useState<PayrollClaim | null>(null);
  const load = useCallback(() => {
    api<{ claims: PayrollClaim[]; pending_count: number }>(`/rh/claims${status ? `?status=${status}` : ''}`)
      .then(setData).catch((e) => setError(errorMessage(e)));
  }, [status]);
  useEffect(load, [load]);
  return (
    <>
      <PageHeader title="Aclaraciones" subtitle="Lo que tus empleados reportan de su asistencia o de sus recibos. Un recibo con aclaración pendiente no se puede firmar." />
      <div className="mb-4 flex flex-wrap gap-1">
        {([['pendiente', 'Pendientes'], ['resuelta', 'Resueltas'], ['rechazada', 'Rechazadas'], ['', 'Todas']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setStatus(k)} className={`rounded-lg px-3 py-1.5 text-sm ${status === k ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
            {label}{k === 'pendiente' && data?.pending_count ? ` (${data.pending_count})` : ''}
          </button>
        ))}
      </div>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : data.claims.length === 0 ? <p className="card p-8 text-center text-sm text-gray-500">No hay aclaraciones.</p> : (
        <div className="space-y-3">
          {data.claims.map((c) => (
            <div key={c.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-white">{c.employee_name}</span>
                    <ClaimBadge status={c.status} />
                    <span className="text-xs text-gray-400">{CLAIM_KIND_LABEL[c.kind]}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {c.date ? `Día ${formatDay(c.date)}` : `Recibo del ${formatDay(c.period_start)} al ${formatDay(c.period_end)}`}
                    {c.amount && ` · ${formatMXN(c.amount)}`} · {formatDateTime(c.created_at)}
                  </p>
                </div>
                {c.status === 'pendiente' && <Button onClick={() => setAnswering(c)}>Responder</Button>}
              </div>
              <p className="mt-2 text-sm text-gray-200">“{c.description}”</p>
              {c.response && <p className="mt-2 rounded-lg bg-gray-900 p-2 text-xs text-gray-400">{c.resolved_by_name}: {c.response}</p>}
            </div>
          ))}
        </div>
      )}
      {answering && <AnswerModal c={answering} onClose={() => setAnswering(null)} onDone={() => { setAnswering(null); load(); }} />}
    </>
  );
}

function AnswerModal({ c, onClose, onDone }: { c: PayrollClaim; onClose: () => void; onDone: () => void }) {
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send(status: 'resuelta' | 'rechazada') {
    setBusy(true);
    setError('');
    try {
      await api(`/rh/claims/${c.id}/resolve`, { method: 'POST', body: { status, response: response.trim() } });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={`Aclaración de ${c.employee_name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-300">“{c.description}”</p>
        <p className="text-xs text-gray-500">Si procede, corrige primero lo necesario (checada, justificación o ajuste) y recalcula el periodo si está en borrador.</p>
        <Field label="Respuesta para el empleado">
          <textarea className="input" rows={3} maxLength={1000} value={response} onChange={(e) => setResponse(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void send('rechazada')} loading={busy} disabled={!response.trim()}><XCircle className="h-4 w-4" /> No procede</Button>
          <Button onClick={() => void send('resuelta')} loading={busy} disabled={!response.trim()}><CheckCircle2 className="h-4 w-4" /> Resuelta</Button>
        </div>
      </div>
    </Modal>
  );
}

const METHOD_LABEL: Record<string, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia', otro: 'Otro' };

/** Aguinaldo del año: calculo por empleado y registro del pago. */
export function AguinaldoPage() {
  const { me } = useAdmin();
  const isAdmin = rhCan.admin(me.user.role);
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<{ year: number; aguinaldo_days: number; employees: AguinaldoRow[] } | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState<AguinaldoRow | null>(null);
  const load = useCallback(() => {
    api<{ year: number; aguinaldo_days: number; employees: AguinaldoRow[] }>(`/rh/aguinaldo?year=${year}`)
      .then(setData).catch((e) => setError(errorMessage(e)));
  }, [year]);
  useEffect(load, [load]);

  async function undo(row: AguinaldoRow) {
    if (!row.payment || !window.confirm(`¿Deshacer el pago del aguinaldo de ${row.full_name}?`)) return;
    try {
      await api(`/rh/aguinaldo/${row.payment.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const total = data?.employees.reduce((s, e) => s + e.amount, 0) ?? 0;
  const paid = data?.employees.reduce((s, e) => s + Number(e.payment?.amount ?? 0), 0) ?? 0;
  return (
    <>
      <PageHeader title="Aguinaldo" subtitle={data ? `${data.aguinaldo_days} días de salario por año, proporcional a lo trabajado. Debe pagarse antes del 20 de diciembre.` : undefined}
        actions={(
          <select className="input w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Año">
            {[0, 1, 2].map((n) => new Date().getFullYear() - n).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : (
        <>
          <p className="mb-3 text-sm text-gray-400">Total {formatMXN(total)} · pagado {formatMXN(paid)}. Los días de aguinaldo se cambian en Configuración.</p>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Empleado</th>
                  <th className="px-4 py-3 font-medium">Días del año</th>
                  <th className="px-4 py-3 font-medium">Salario diario</th>
                  <th className="px-4 py-3 text-right font-medium">Aguinaldo</th>
                  <th className="px-4 py-3 text-right font-medium">Pago</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {data.employees.map((e) => (
                  <tr key={e.employee_id}>
                    <td className="px-4 py-3 text-white">{e.full_name}<div className="text-xs text-gray-500">desde {formatDay(e.hire_date)}{e.termination_date ? ` · baja ${formatDay(e.termination_date)}` : ''}</div></td>
                    <td className="px-4 py-3 text-gray-300">{e.days_counted}{e.proportional && <span className="ml-1 text-xs text-gray-500">(proporcional)</span>}</td>
                    <td className="px-4 py-3 text-gray-300">{formatMXN(e.daily_base)}</td>
                    <td className="px-4 py-3 text-right font-medium text-white">{formatMXN(e.amount)}</td>
                    <td className="px-4 py-3 text-right">
                      {e.payment ? (
                        <span className="inline-flex items-center gap-2 text-xs text-emerald-300">
                          {formatMXN(e.payment.amount)} · {METHOD_LABEL[e.payment.method]} · {formatDay(e.payment.paid_at.slice(0, 10))}
                          {isAdmin && <button className="text-gray-500 hover:text-white" aria-label="Deshacer pago" onClick={() => void undo(e)}><Undo2 className="h-3.5 w-3.5" /></button>}
                        </span>
                      ) : isAdmin && e.amount > 0 ? <Button variant="secondary" onClick={() => setPaying(e)}>Registrar pago</Button>
                        : <span className="text-xs text-gray-500">Pendiente</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {paying && data && <PayModal row={paying} year={data.year} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />}
    </>
  );
}

function PayModal({ row, year, onClose, onDone }: { row: AguinaldoRow; year: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(row.amount));
  const [method, setMethod] = useState('transferencia');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    try {
      await api('/rh/aguinaldo/pay', { method: 'POST', body: { employee_id: row.employee_id, year, amount: Number(amount), method, notes: notes.trim() || null } });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={`Aguinaldo ${year} · ${row.full_name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-400">{row.aguinaldo_days} días × {formatMXN(row.daily_base)} × {row.days_counted}/365 = <b className="text-white">{formatMXN(row.amount)}</b></p>
        <Field label="Monto pagado ($)"><input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Forma de pago">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Nota (opcional)"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} loading={busy} disabled={!(Number(amount) > 0)}>Registrar pago</Button>
        </div>
      </div>
    </Modal>
  );
}
