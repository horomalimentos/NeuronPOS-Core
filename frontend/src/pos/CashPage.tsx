import { ArrowDownCircle, ArrowUpCircle, Lock, Printer, Unlock } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { useAdmin } from '../restaurant/context';
import BranchSelect from './BranchSelect';
import { formatDateTime, num, posPrefs, round2 } from './lib';
import { cashCutHtml, printHtml } from './ticket';
import type { CashSession, CashSessionDetail } from './types';
import { usePosBranch } from './usePosBranch';

/**
 * Caja: abrir turno con fondo, entradas/salidas de efectivo, corte (esperado
 * contra contado por metodo de pago) e historial. Adaptado de OpenShiftModal,
 * CashMovementsModal y CloseShiftModal de NeuronPOS.
 */
export default function CashPage() {
  const { me } = useAdmin();
  const { branchId, setBranchId, branches } = usePosBranch();
  const [terminal, setTerminal] = useState(posPrefs.getTerminal());
  const [sessions, setSessions] = useState<CashSession[] | null>(null);
  const [detail, setDetail] = useState<CashSessionDetail | null>(null);
  const [viewing, setViewing] = useState<CashSessionDetail | null>(null);
  const [error, setError] = useState('');

  const current = sessions?.find((s) => s.status === 'abierta' && s.terminal.toLowerCase() === terminal.toLowerCase()) || null;

  const load = useCallback(() => {
    if (!branchId) return;
    api<{ sessions: CashSession[] }>(`/pos/cash-sessions?branch_id=${branchId}&limit=30`)
      .then((r) => setSessions(r.sessions)).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(load, [load]);

  const loadDetail = useCallback((id: string) => {
    api<CashSessionDetail>(`/pos/cash-sessions/${id}`).then(setDetail).catch((e) => setError(errorMessage(e)));
  }, []);
  const currentId = current?.id;
  useEffect(() => {
    if (currentId) loadDetail(currentId);
    else setDetail(null);
  }, [currentId, loadDetail]);

  const print = (d: CashSessionDetail) => printHtml(cashCutHtml(d, me.restaurant));
  const openOthers = (sessions || []).filter((s) => s.status === 'abierta' && s.id !== current?.id);

  return (
    <>
      <PageHeader
        title="Caja"
        subtitle="Turnos por sucursal y terminal, movimientos de efectivo y corte."
        actions={<BranchSelect branches={branches} value={branchId} onChange={setBranchId} />}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Terminal de este dispositivo">
          <input className="input w-48" value={terminal} maxLength={40}
            onChange={(e) => setTerminal(e.target.value)}
            onBlur={() => { const t = terminal.trim() || 'Caja 1'; setTerminal(t); posPrefs.setTerminal(t); }} />
        </Field>
        {openOthers.length > 0 && (
          <p className="pb-2 text-sm text-gray-400">Otras cajas abiertas: {openOthers.map((s) => (
            <button key={s.id} className="ml-1 text-brand underline" onClick={() => { setTerminal(s.terminal); posPrefs.setTerminal(s.terminal); }}>{s.terminal}</button>
          ))}</p>
        )}
      </div>

      {!sessions ? <Spinner /> : current ? (
        detail ? <OpenSessionPanel detail={detail} onChanged={() => loadDetail(current.id)} onClosed={(d) => { setViewing(d); load(); }} onPrint={print} /> : <Spinner />
      ) : (
        <OpenForm branchId={branchId} terminal={terminal} onOpened={load} />
      )}

      <h2 className="mb-3 mt-10 text-sm font-medium uppercase tracking-wider text-gray-500">Historial de cortes</h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">Terminal</th>
              <th className="px-4 py-3 font-medium">Apertura</th>
              <th className="px-4 py-3 font-medium">Cierre</th>
              <th className="px-4 py-3 text-right font-medium">Ventas</th>
              <th className="px-4 py-3 text-right font-medium">Diferencia</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(sessions || []).filter((s) => s.status === 'cerrada').map((s) => (
              <tr key={s.id} className="cursor-pointer hover:bg-gray-800/50"
                onClick={() => api<CashSessionDetail>(`/pos/cash-sessions/${s.id}`).then(setViewing).catch((e) => setError(errorMessage(e)))}>
                <td className="px-4 py-3 text-white">{s.terminal}<div className="text-xs text-gray-500">{s.opened_by_name}</div></td>
                <td className="px-4 py-3 text-gray-400">{formatDateTime(s.opened_at)}</td>
                <td className="px-4 py-3 text-gray-400">{formatDateTime(s.closed_at)}</td>
                <td className="px-4 py-3 text-right text-gray-200">{formatMXN(s.total_sales)}</td>
                <td className={`px-4 py-3 text-right font-semibold ${num(s.difference) < 0 ? 'text-red-400' : num(s.difference) > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>{formatMXN(s.difference)}</td>
              </tr>
            ))}
            {sessions && !sessions.some((s) => s.status === 'cerrada') && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Todavía no hay cortes.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {viewing && (
        <Modal title={`Corte · ${viewing.session.terminal}`} onClose={() => setViewing(null)} wide>
          <CutSummary detail={viewing} />
          <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={() => print(viewing)}><Printer className="h-4 w-4" /> Imprimir corte</Button></div>
        </Modal>
      )}
    </>
  );
}

function OpenForm({ branchId, terminal, onOpened }: { branchId: string; terminal: string; onOpened: () => void }) {
  const [cash, setCash] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/pos/cash-sessions/open', { method: 'POST', body: { branch_id: branchId, terminal, opening_cash: num(cash) } });
      onOpened();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={submit} className="card max-w-md space-y-4 p-5">
      <h2 className="flex items-center gap-2 font-semibold text-white"><Unlock className="h-5 w-5 text-brand" /> Abrir {terminal}</h2>
      {error && <Alert>{error}</Alert>}
      <Field label="Fondo inicial en efectivo">
        <input className="input text-lg font-semibold" type="number" inputMode="decimal" min="0" step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" autoFocus />
      </Field>
      <Button type="submit" loading={saving} className="w-full py-3">Abrir caja</Button>
    </form>
  );
}

function OpenSessionPanel({ detail, onChanged, onClosed, onPrint }: {
  detail: CashSessionDetail; onChanged: () => void; onClosed: (d: CashSessionDetail) => void; onPrint: (d: CashSessionDetail) => void;
}) {
  const { session, cut, movements } = detail;
  const [mv, setMv] = useState({ kind: 'salida' as 'entrada' | 'salida', amount: '', reason: '' });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function addMovement(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/pos/cash-sessions/${session.id}/movements`, { method: 'POST', body: { ...mv, amount: num(mv.amount) } });
      setMv({ ...mv, amount: '', reason: '' });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function close(e: FormEvent) {
    e.preventDefault();
    if (!window.confirm('¿Cerrar la caja con este corte?')) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<CashSessionDetail>(`/pos/cash-sessions/${session.id}/close`, {
        method: 'POST',
        body: {
          counts: cut.methods.filter((m) => counts[m.payment_method_id] !== undefined && counts[m.payment_method_id] !== '')
            .map((m) => ({ payment_method_id: m.payment_method_id, counted: num(counts[m.payment_method_id]) })),
          notes: notes || null,
        },
      });
      onClosed(r);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-400">
          <span className="font-semibold text-emerald-300">{session.terminal} abierta</span> desde {formatDateTime(session.opened_at)} por {session.opened_by_name}
        </p>
        <Button variant="secondary" onClick={() => onPrint(detail)}><Printer className="h-4 w-4" /> Imprimir corte parcial</Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Fondo inicial" value={formatMXN(cut.opening_cash)} />
        <Stat label="Ventas" value={formatMXN(cut.total_sales)} hint={`${cut.orders_count} órdenes`} />
        <Stat label="Propinas" value={formatMXN(cut.total_tips)} />
        <Stat label="Efectivo esperado" value={formatMXN(cut.expected_cash)} strong />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h3 className="mb-3 font-semibold text-white">Entradas y salidas de efectivo</h3>
          <form onSubmit={addMovement} className="mb-4 grid gap-2 sm:grid-cols-[auto_8rem_1fr_auto]">
            <select className="input" value={mv.kind} onChange={(e) => setMv({ ...mv, kind: e.target.value as 'entrada' | 'salida' })} aria-label="Tipo">
              <option value="salida">Salida</option>
              <option value="entrada">Entrada</option>
            </select>
            <input className="input" type="number" inputMode="decimal" min="0.01" step="0.01" required placeholder="Monto" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} />
            <input className="input" required maxLength={200} placeholder="Motivo (ej. compra de hielo)" value={mv.reason} onChange={(e) => setMv({ ...mv, reason: e.target.value })} />
            <Button type="submit" loading={busy}>Agregar</Button>
          </form>
          {movements.length === 0 ? <p className="text-sm text-gray-500">Sin movimientos.</p> : (
            <ul className="divide-y divide-gray-800 text-sm">
              {movements.map((m) => (
                <li key={m.id} className="flex items-center gap-2 py-2">
                  {m.kind === 'entrada' ? <ArrowDownCircle className="h-4 w-4 text-emerald-400" /> : <ArrowUpCircle className="h-4 w-4 text-red-400" />}
                  <span className="flex-1 text-gray-200">{m.reason}<span className="block text-xs text-gray-500">{formatDateTime(m.created_at)} · {m.created_by_name}</span></span>
                  <span className={m.kind === 'entrada' ? 'text-emerald-300' : 'text-red-300'}>{m.kind === 'entrada' ? '+' : '-'}{formatMXN(m.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form onSubmit={close} className="card p-5">
          <h3 className="mb-3 flex items-center gap-2 font-semibold text-white"><Lock className="h-4 w-4" /> Cerrar caja (corte)</h3>
          <table className="mb-4 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="py-2 font-medium">Método</th><th className="py-2 text-right font-medium">Esperado</th><th className="py-2 text-right font-medium">Contado</th><th className="py-2 text-right font-medium">Dif.</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {cut.methods.map((m) => {
                const v = counts[m.payment_method_id];
                const diff = v === undefined || v === '' ? null : round2(num(v) - m.expected);
                return (
                  <tr key={m.payment_method_id}>
                    <td className="py-2 text-gray-200">{m.name}<span className="block text-xs text-gray-500">{m.payments} pagos{m.tips ? ` · propinas ${formatMXN(m.tips)}` : ''}</span></td>
                    <td className="py-2 text-right text-gray-300">{formatMXN(m.expected)}</td>
                    <td className="py-2 pl-2 text-right">
                      {m.kind === 'puntos' || m.kind === 'monedero' ? <span className="text-xs text-gray-500">No se cuenta</span> : (
                        <input className="input w-28 py-1.5 text-right" type="number" inputMode="decimal" min="0" step="0.01"
                          required={m.kind === 'efectivo' || m.expected !== 0} value={v ?? ''}
                          onChange={(e) => setCounts({ ...counts, [m.payment_method_id]: e.target.value })} aria-label={`Contado ${m.name}`} />
                      )}
                    </td>
                    <td className={`py-2 text-right font-semibold ${diff === null ? 'text-gray-600' : diff < 0 ? 'text-red-400' : diff > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
                      {diff === null ? '—' : formatMXN(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Field label="Notas del corte"><textarea className="input" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <Button type="submit" variant="danger" loading={busy} className="mt-4 w-full">Cerrar caja</Button>
        </form>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={`card p-4 ${strong ? 'ring-1 ring-brand/40' : ''}`}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-xl font-semibold text-white">{value}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function CutSummary({ detail }: { detail: CashSessionDetail }) {
  const { session, cut, movements } = detail;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-gray-400">
        {session.branch_name} · Abrió {session.opened_by_name} {formatDateTime(session.opened_at)}
        {session.closed_at && <> · Cerró {session.closed_by_name} {formatDateTime(session.closed_at)}</>}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Fondo" value={formatMXN(cut.opening_cash)} />
        <Stat label="Ventas" value={formatMXN(cut.total_sales)} hint={`${cut.orders_count} órdenes`} />
        <Stat label="Entradas / salidas" value={`${formatMXN(cut.cash_in)} / ${formatMXN(cut.cash_out)}`} />
        <Stat label="Diferencia efectivo" value={formatMXN(cut.cash_difference ?? 0)} strong />
      </div>
      <table className="w-full">
        <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
          <tr><th className="py-2 font-medium">Método</th><th className="py-2 text-right font-medium">Ventas</th><th className="py-2 text-right font-medium">Propinas</th><th className="py-2 text-right font-medium">Esperado</th><th className="py-2 text-right font-medium">Contado</th><th className="py-2 text-right font-medium">Dif.</th></tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {cut.methods.map((m) => (
            <tr key={m.payment_method_id}>
              <td className="py-2 text-gray-200">{m.name}</td>
              <td className="py-2 text-right">{formatMXN(m.sales)}</td>
              <td className="py-2 text-right">{formatMXN(m.tips)}</td>
              <td className="py-2 text-right">{formatMXN(m.expected)}</td>
              <td className="py-2 text-right">{m.counted === undefined ? '—' : formatMXN(m.counted)}</td>
              <td className={`py-2 text-right font-semibold ${num(m.difference) < 0 ? 'text-red-400' : num(m.difference) > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>{m.difference === undefined ? '—' : formatMXN(m.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {movements.length > 0 && (
        <ul className="space-y-1 text-gray-300">
          {movements.map((m) => <li key={m.id}>{m.kind === 'entrada' ? '+' : '-'}{formatMXN(m.amount)} · {m.reason}</li>)}
        </ul>
      )}
      {session.notes && <p className="rounded-lg bg-gray-800 p-3 text-gray-300">{session.notes}</p>}
    </div>
  );
}
