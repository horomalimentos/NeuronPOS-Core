import { FileSignature, MessageSquareWarning } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, PageHeader, Spinner } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { printHtml } from '../pos/ticket';
import { useAdmin } from '../restaurant/context';
import { DayTable } from './AttendancePage';
import { DOW_LABEL, FREQUENCY_LABEL, PERIOD_STATUS_LABEL, addDaysStr, hours, inZone, shortDay } from './lib';
import { ClaimModal, MyAguinaldo, MyClaims, MyLive } from './MyExtras';
import { ReceiptView } from './PayrollPeriodPage';
import { receiptHtml } from './print';
import type { AttendanceDay, AttendanceSummary, MyEmployee, PayrollItem, PayrollPeriod, RosterDay } from './types';

interface MyAttendance {
  from: string;
  to: string;
  timezone: string;
  summary: AttendanceSummary;
  days: AttendanceDay[];
  entries: { id: string; kind: 'entrada' | 'salida'; occurred_at: string; source: string; voided: boolean }[];
}

/** Autoservicio del empleado: su horario, checadas y recibos de nómina. */
export default function MyPayrollPage() {
  const { me } = useAdmin();
  const hasShifts = me.modules.some((m) => m.code === 'turnos' && m.enabled);
  const [employee, setEmployee] = useState<MyEmployee | null>(null);
  const [notLinked, setNotLinked] = useState('');
  const [attendance, setAttendance] = useState<MyAttendance | null>(null);
  const [receipts, setReceipts] = useState<PayrollItem[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [claim, setClaim] = useState<{ itemId?: string; date?: string } | null>(null);
  const [claimsKey, setClaimsKey] = useState(0);

  const load = useCallback(() => {
    api<{ employee: MyEmployee }>('/rh/me').then((r) => {
      setEmployee(r.employee);
      api<MyAttendance>('/rh/me/attendance').then(setAttendance).catch((e) => setError(errorMessage(e)));
      api<{ receipts: PayrollItem[] }>('/rh/me/receipts').then((x) => setReceipts(x.receipts)).catch((e) => setError(errorMessage(e)));
    }).catch((e) => {
      if (e instanceof ApiError && e.code === 'NOT_AN_EMPLOYEE') setNotLinked(e.message);
      else setError(errorMessage(e));
    });
  }, []);
  useEffect(load, [load]);

  if (notLinked) return <><PageHeader title="Mi nómina" /><Alert kind="warning">{notLinked}</Alert></>;
  if (!employee) return error ? <Alert>{error}</Alert> : <Spinner />;

  return (
    <>
      <PageHeader title="Mi nómina" subtitle={`${employee.full_name}${employee.position ? ` · ${employee.position}` : ''} · ${employee.branch_name}`} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        {hasShifts ? <MyShifts /> : (
        <section className="card p-5">
            <h2 className="mb-3 font-semibold text-white">Mi horario</h2>
            <ul className="space-y-1 text-sm">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const s = employee.schedule.find((x) => x.day_of_week === d);
                return <li key={d} className="flex justify-between"><span className="text-gray-400">{DOW_LABEL[d]}</span><span className={s ? 'text-white' : 'text-gray-600'}>{s ? `${s.start_time} a ${s.end_time}` : 'Descanso'}</span></li>;
              })}
            </ul>
            <p className="mt-3 text-xs text-gray-500">Pago {FREQUENCY_LABEL[employee.payment_frequency].toLowerCase()} · desde {formatDay(employee.hire_date)}{!employee.has_pin && ' · pide tu NIP del checador a tu gerente'}</p>
          </section>
        )}
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-1 font-semibold text-white">Mis últimas dos semanas</h2>
          {!attendance ? <Spinner /> : (
            <>
              <p className="mb-3 text-sm text-gray-400">
                {attendance.summary.days_worked} días trabajados · {hours(attendance.summary.minutes_worked)} ·
                {' '}{attendance.summary.tardies} retardo(s) · {attendance.summary.absences} falta(s)
              </p>
              <div className="overflow-x-auto"><DayTable days={attendance.days} /></div>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-gray-300">Mis checadas ({attendance.entries.length})</summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {attendance.entries.map((t) => {
                    const l = inZone(t.occurred_at, attendance.timezone);
                    return <li key={t.id} className={t.voided ? 'text-gray-600 line-through' : 'text-gray-300'}>{shortDay(l.date)} {l.time} · {t.kind}{t.source !== 'kiosco' && ` (${t.source})`}</li>;
                  })}
                </ul>
              </details>
            </>
          )}
        </section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <MyLive onClaim={(date) => setClaim({ date })} />
        <MyClaims refreshKey={claimsKey} onNew={() => setClaim({})} />
        <MyAguinaldo />
      </div>

      <section className="card mt-6 overflow-x-auto">
        <h2 className="px-5 pt-5 font-semibold text-white">Mis recibos</h2>
        {!receipts ? <Spinner /> : receipts.length === 0 ? <p className="p-5 text-sm text-gray-500">Todavía no tienes recibos aprobados.</p> : (
          <table className="mt-2 w-full text-sm">
            <tbody className="divide-y divide-gray-800">
              {receipts.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-gray-800/40" onClick={() => setOpen(r.id)}>
                  <td className="px-5 py-3 text-white">{formatDay(r.start_date)} al {formatDay(r.end_date)}<div className="text-xs text-gray-500">{r.period_status && PERIOD_STATUS_LABEL[r.period_status]}</div></td>
                  <td className="px-5 py-3 text-right font-semibold text-white">{formatMXN(r.net)}</td>
                  <td className="px-5 py-3 text-right text-xs">
                    {r.signed_at ? <span className="text-sky-300">Firmado</span> : <span className="text-amber-300">Por firmar</span>}
                    <div className="text-gray-500">{r.paid_at ? 'Pagado' : 'Pendiente de pago'}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {open && <MyReceiptModal id={open} onClose={() => setOpen(null)} onSigned={load}
        onClaim={() => { setClaim({ itemId: open }); setOpen(null); }} />}
      {claim && <ClaimModal {...claim} onClose={() => setClaim(null)} onSaved={() => setClaimsKey((k) => k + 1)} />}
    </>
  );
}

function MyReceiptModal({ id, onClose, onSigned, onClaim }: { id: string; onClose: () => void; onSigned: () => void; onClaim: () => void }) {
  const { me } = useAdmin();
  const [data, setData] = useState<{ item: PayrollItem; period: PayrollPeriod } | null>(null);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ item: PayrollItem; period: PayrollPeriod }>(`/rh/me/receipts/${id}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [id]);
  async function sign() {
    setSaving(true);
    try {
      setData(await api(`/rh/me/receipts/${id}/sign`, { method: 'POST', body: { accept: true } }));
      onSigned();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Mi recibo de nómina" onClose={onClose} wide>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">{formatDay(data.period.start_date)} al {formatDay(data.period.end_date)}</p>
          <ReceiptView item={data.item} onPrint={() => printHtml(receiptHtml(data.item, data.period, me.restaurant), 'documento')} />
          {data.item.signed_at ? (
            <Alert kind="success">Aceptaste este recibo el {formatDateTime(data.item.signed_at)} por {formatMXN(data.item.net_at_signing)}.</Alert>
          ) : (
            <div className="rounded-xl border border-gray-800 p-4">
              <label className="flex items-start gap-3 text-sm text-gray-300">
                <input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                Revisé mi recibo y estoy de acuerdo con el pago neto de {formatMXN(data.item.net)}.
              </label>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={onClaim}><MessageSquareWarning className="h-4 w-4" /> Pedir aclaración</Button>
                <Button onClick={sign} disabled={!accept} loading={saving}><FileSignature className="h-4 w-4" /> Firmar recibo</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Turnos de la semana del empleado (modulo turnos), con el horario fijo donde no hay rol. */
function MyShifts() {
  const [start, setStart] = useState<string | null>(null);
  const [data, setData] = useState<{ start: string; end: string; today: string; days: RosterDay[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ start: string; end: string; today: string; days: RosterDay[] }>(`/rh/shifts/mine${start ? `?start=${start}` : ''}`)
      .then(setData).catch((e) => setError(errorMessage(e)));
  }, [start]);
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-white">Mis turnos</h2>
        {data && (
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <button className="rounded px-1.5 py-0.5 hover:bg-gray-800 hover:text-white" aria-label="Semana anterior" onClick={() => setStart(addDaysStr(data.start, -7))}>‹</button>
            {shortDay(data.start)} al {shortDay(data.end)}
            <button className="rounded px-1.5 py-0.5 hover:bg-gray-800 hover:text-white" aria-label="Semana siguiente" onClick={() => setStart(addDaysStr(data.start, 7))}>›</button>
          </div>
        )}
      </div>
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : (
        <ul className="space-y-1 text-sm">
          {data.days.map((d) => (
            <li key={d.date} className={`flex justify-between gap-2 rounded px-1 ${d.date === data.today ? 'bg-gray-800/70' : ''}`}>
              <span className="text-gray-400">{shortDay(d.date)}</span>
              <span className={d.is_rest || !d.start_time ? 'text-gray-600' : 'text-white'}>
                {d.outside ? '—' : d.is_rest || !d.start_time ? 'Descanso'
                  : <>{d.shift_name && <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: d.color || '#64748B' }} />}{d.shift_name ? `${d.shift_name} · ` : ''}{d.start_time} a {d.end_time}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
