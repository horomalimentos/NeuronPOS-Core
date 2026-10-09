import { ArrowLeft, CheckCircle2, Download, Lock, Printer, RefreshCw, Unlock, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { printHtml } from '../pos/ticket';
import type { CashSession } from '../pos/types';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import { DayTable } from './AttendancePage';
import { FREQUENCY_LABEL, PAY_METHOD_LABEL, PERIOD_STATUS_LABEL, PERIOD_STATUS_STYLE, downloadFile, hours, rhCan } from './lib';
import { receiptHtml, receiptsHtml } from './print';
import type { PayrollItem, PayrollPeriod } from './types';

interface Detail { period: PayrollPeriod; items: PayrollItem[]; skipped?: { full_name: string; reason: string }[] }

/** Prenomina de un periodo: revisar, recalcular, aprobar, pagar y cerrar. */
export default function PayrollPeriodPage() {
  const { id } = useParams();
  const { me } = useAdmin();
  const isAdmin = rhCan.admin(me.user.role);
  const hasPos = Boolean(me.modules.find((m) => m.code === 'pos')?.enabled);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayrollItem | null>(null);

  const load = useCallback(() => {
    api<Detail>(`/rh/payroll/periods/${id}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  async function action(name: string, path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const r = await api<Detail>(`/rh/payroll/periods/${id}/${path}`, { method: 'POST', body });
      setData(r);
      if (r.skipped?.length) setNotice(`Sin salario configurado (no se incluyen): ${r.skipped.map((s) => s.full_name).join(', ')}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy('');
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const { period, items } = data;
  const unpaid = items.filter((i) => !i.paid_at).length;

  return (
    <>
      <Link to="/admin/rh/nomina" className="mb-3 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Periodos</Link>
      <PageHeader
        title={`Nómina ${FREQUENCY_LABEL[period.frequency].toLowerCase()} · ${formatDay(period.start_date)} al ${formatDay(period.end_date)}`}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${PERIOD_STATUS_STYLE[period.status]}`}>{PERIOD_STATUS_LABEL[period.status]}</span>
          {period.calculated_at && <span>Calculada {formatDateTime(period.calculated_at)}</span>}
          {period.approved_by_name && <span>· aprobó {period.approved_by_name}</span>}
          {period.closed_by_name && <span>· cerró {period.closed_by_name}</span>}
        </span>}
        actions={<>
          <Button variant="secondary" onClick={() => downloadFile(`/rh/payroll/periods/${period.id}/export.csv`, `nomina-${period.start_date}.csv`).catch((e) => setError(errorMessage(e)))}>
            <Download className="h-4 w-4" /> CSV
          </Button>
          <Button variant="secondary" onClick={() => printHtml(receiptsHtml(items, period, me.restaurant), 'documento')} disabled={!items.length}><Printer className="h-4 w-4" /> Imprimir recibos</Button>
          {period.status === 'borrador' && <Button variant="secondary" loading={busy === 'calc'} onClick={() => action('calc', 'calculate')}><RefreshCw className="h-4 w-4" /> Recalcular</Button>}
          {period.status === 'borrador' && isAdmin && <Button loading={busy === 'approve'} onClick={() => action('approve', 'approve', undefined, 'Al aprobar, los recibos quedan fijos y los empleados podrán verlos y firmarlos. ¿Aprobar?')}><CheckCircle2 className="h-4 w-4" /> Aprobar</Button>}
          {period.status === 'aprobada' && isAdmin && <Button variant="secondary" loading={busy === 'reopen'} onClick={() => action('reopen', 'reopen')}><Unlock className="h-4 w-4" /> Reabrir</Button>}
          {period.status === 'aprobada' && unpaid > 0 && <Button variant="secondary" loading={busy === 'payall'} onClick={() => action('payall', 'pay-all', { method: 'transferencia' }, `¿Marcar ${unpaid} recibo(s) como pagados por transferencia?`)}><Wallet className="h-4 w-4" /> Pagar pendientes</Button>}
          {period.status === 'aprobada' && isAdmin && <Button loading={busy === 'close'} onClick={() => action('close', 'close')}><Lock className="h-4 w-4" /> Cerrar periodo</Button>}
        </>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="mb-4"><Alert kind="warning">{notice}</Alert></div>}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-4"><div className="text-xs uppercase text-gray-500">Percepciones</div><div className="mt-1 text-xl font-semibold text-white">{formatMXN(period.total_gross)}</div></div>
        <div className="card p-4"><div className="text-xs uppercase text-gray-500">Deducciones</div><div className="mt-1 text-xl font-semibold text-white">{formatMXN(period.total_deductions)}</div></div>
        <div className="card p-4"><div className="text-xs uppercase text-gray-500">Neto a pagar</div><div className="mt-1 text-xl font-semibold text-brand">{formatMXN(period.total_net)}</div></div>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">Empleado</th>
              <th className="px-4 py-3 font-medium">Días</th>
              <th className="px-4 py-3 font-medium">Incidencias</th>
              <th className="px-4 py-3 font-medium">Extra</th>
              <th className="px-4 py-3 text-right font-medium">Percepciones</th>
              <th className="px-4 py-3 text-right font-medium">Deducciones</th>
              <th className="px-4 py-3 text-right font-medium">Neto</th>
              <th className="px-4 py-3 font-medium">Pago / firma</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {items.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">Sin empleados con esta frecuencia y salario configurado.</td></tr>}
            {items.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-gray-800/40" onClick={() => setViewing(i.id)}>
                <td className="px-4 py-3"><div className="font-medium text-white">{i.employee_name}</div><div className="text-xs text-gray-500">{[i.position, i.branch_name].filter(Boolean).join(' · ')}</div></td>
                <td className="px-4 py-3 text-gray-300">{i.days_worked}/{i.days_scheduled}{i.pay_type === 'diario' && <div className="text-xs text-gray-500">{Number(i.days_paid)} pagados</div>}</td>
                <td className="px-4 py-3 text-xs">
                  {i.tardies > 0 && <div className="text-amber-300">{i.tardies} retardo(s)</div>}
                  {i.absences > 0 && <div className="text-red-300">{i.absences} falta(s)</div>}
                  {i.holidays_worked > 0 && <div className="text-violet-300">{i.holidays_worked} festivo(s) trabajado(s)</div>}
                  {!i.tardies && !i.absences && !i.holidays_worked && <span className="text-gray-600">—</span>}
                </td>
                <td className="px-4 py-3 text-xs text-gray-400">{i.overtime_minutes_double + i.overtime_minutes_triple ? hours(i.overtime_minutes_double + i.overtime_minutes_triple) : '—'}</td>
                <td className="px-4 py-3 text-right text-gray-300">{formatMXN(i.gross)}</td>
                <td className="px-4 py-3 text-right text-gray-300">{formatMXN(i.deductions)}</td>
                <td className="px-4 py-3 text-right font-semibold text-white">{formatMXN(i.net)}</td>
                <td className="px-4 py-3 text-xs" onClick={(e) => e.stopPropagation()}>
                  {i.paid_at
                    ? <div className="text-emerald-300">Pagado · {i.paid_method && PAY_METHOD_LABEL[i.paid_method]}</div>
                    : period.status === 'aprobada'
                      ? <button className="rounded-lg bg-gray-800 px-2 py-1 text-gray-200 hover:bg-gray-700" onClick={() => setPaying(i)}>Pagar</button>
                      : <span className="text-gray-600">Sin pagar</span>}
                  <div className={i.signed_at ? 'text-sky-300' : 'text-gray-600'}>{i.signed_at ? 'Firmado' : 'Sin firma'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing && <ItemModal itemId={viewing} onClose={() => setViewing(null)} />}
      {paying && <PayModal item={paying} hasPos={hasPos} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); load(); }} />}
    </>
  );
}

function ItemModal({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { me } = useAdmin();
  const [data, setData] = useState<{ item: PayrollItem; period: PayrollPeriod } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ item: PayrollItem; period: PayrollPeriod }>(`/rh/payroll/items/${itemId}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [itemId]);
  return (
    <Modal title={data ? `Recibo · ${data.item.employee_name}` : 'Recibo'} onClose={onClose} wide>
      {error && <Alert>{error}</Alert>}
      {!data ? <Spinner /> : <ReceiptView item={data.item} onPrint={() => printHtml(receiptHtml(data.item, data.period, me.restaurant), 'documento')} />}
    </Modal>
  );
}

/** Desglose de un recibo (lo usa tambien "Mi nomina"). */
export function ReceiptView({ item, onPrint }: { item: PayrollItem; onPrint?: () => void }) {
  const per = item.lines.filter((l) => l.kind === 'percepcion');
  const ded = item.lines.filter((l) => l.kind === 'deduccion');
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {[['Percepciones', per, item.gross], ['Deducciones', ded, item.deductions]].map(([title, lines, total]) => (
          <div key={title as string}>
            <h3 className="mb-2 text-sm font-semibold text-white">{title as string}</h3>
            <ul className="space-y-1 text-sm">
              {(lines as PayrollItem['lines']).length === 0 && <li className="text-gray-500">—</li>}
              {(lines as PayrollItem['lines']).map((l, i) => (
                <li key={i} className="flex justify-between gap-3 text-gray-300"><span>{l.concept}</span><span>{formatMXN(l.amount)}</span></li>
              ))}
              <li className="flex justify-between border-t border-gray-800 pt-1 font-semibold text-white"><span>Total</span><span>{formatMXN(total as string)}</span></li>
            </ul>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-xl bg-gray-800/60 px-4 py-3">
        <span className="text-sm text-gray-400">Neto a pagar</span>
        <span className="text-xl font-semibold text-white">{formatMXN(item.net)}</span>
      </div>
      {item.detail && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-white">Asistencia del periodo</summary>
          <div className="mt-2 overflow-x-auto"><DayTable days={item.detail} /></div>
        </details>
      )}
      {onPrint && <div className="flex justify-end"><Button variant="secondary" onClick={onPrint}><Printer className="h-4 w-4" /> Imprimir recibo</Button></div>}
    </div>
  );
}

function PayModal({ item, hasPos, onClose, onSaved }: { item: PayrollItem; hasPos: boolean; onClose: () => void; onSaved: () => void }) {
  const { me } = useAdmin();
  const [method, setMethod] = useState<'caja' | 'efectivo' | 'transferencia' | 'otro'>(hasPos ? 'caja' : 'transferencia');
  const [sessions, setSessions] = useState<CashSession[] | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hasPos) return;
    Promise.all(me.branches.map((b) => api<{ sessions: CashSession[] }>(`/pos/cash-sessions?branch_id=${b.id}&status=abierta`).then((r) => r.sessions).catch(() => [])))
      .then((lists) => {
        const all = lists.flat();
        setSessions(all);
        if (all[0]) setSessionId(all[0].id);
      });
  }, [hasPos, me.branches]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api(`/rh/payroll/items/${item.id}/pay`, { method: 'POST', body: { method, cash_session_id: method === 'caja' ? sessionId : undefined } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={`Pagar a ${item.employee_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="text-2xl font-semibold text-white">{formatMXN(item.net)}</div>
        <Field label="Forma de pago">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {hasPos && <option value="caja">Desde la caja del POS (salida de efectivo)</option>}
            <option value="efectivo">Efectivo (fuera de caja)</option>
            <option value="transferencia">Transferencia</option>
            <option value="otro">Otro</option>
          </select>
        </Field>
        {method === 'caja' && (
          !sessions ? <Spinner /> : sessions.length === 0
            ? <Alert kind="warning">No hay turnos de caja abiertos. Abre la caja en el punto de venta o elige otra forma de pago.</Alert>
            : (
              <Field label="Turno de caja" hint="Se registra como salida de efectivo y se descuenta del corte.">
                <select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                  {sessions.map((s) => <option key={s.id} value={s.id}>{s.branch_name} · {s.terminal} · {s.opened_by_name}</option>)}
                </select>
              </Field>
            )
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving} disabled={method === 'caja' && !sessionId}>Registrar pago</Button>
        </div>
      </form>
    </Modal>
  );
}
