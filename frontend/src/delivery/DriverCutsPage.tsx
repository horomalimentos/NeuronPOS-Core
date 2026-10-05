import { ArrowLeft, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import BranchSelect from '../pos/BranchSelect';
import { formatDateTime, formatTime, posPrefs } from '../pos/lib';
import type { CashSession } from '../pos/types';
import { usePosBranch } from '../pos/usePosBranch';
import type { DriverCut, PendingCut } from './types';

/**
 * Corte del repartidor: al terminar su turno entrega el efectivo que cobró
 * en la puerta. Se compara contra sus entregas y ese efectivo entra al turno
 * de caja abierto (y de ahí al corte de caja).
 */
export default function DriverCutsPage() {
  const { branchId, setBranchId, branches } = usePosBranch();
  const [data, setData] = useState<{ pending: PendingCut[]; cuts: DriverCut[] } | null>(null);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [cutting, setCutting] = useState<PendingCut | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    if (!branchId) return;
    api<{ pending: PendingCut[]; cuts: DriverCut[] }>(`/delivery/driver-cuts?branch_id=${branchId}`)
      .then(setData).catch((e) => setError(errorMessage(e)));
    api<{ sessions: CashSession[] }>(`/pos/cash-sessions?branch_id=${branchId}&status=abierta`)
      .then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
  }, [branchId]);
  useEffect(load, [load]);

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <>
      <Link to="/admin/reparto" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Reparto</Link>
      <PageHeader title="Cortes de repartidores" subtitle="El efectivo que cobraron en la puerta entra al turno de caja abierto."
        actions={<BranchSelect branches={branches} value={branchId} onChange={setBranchId} />} />
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
        {sessions.length === 0 && <Alert kind="warning">No hay una caja abierta en esta sucursal: ábrela en <Link to="/admin/caja" className="underline">Caja</Link> para recibir el efectivo.</Alert>}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {data.pending.map((p) => (
          <section key={p.driver_user_id} className="card p-5">
            <div className="flex items-start justify-between">
              <h2 className="font-semibold text-white">{p.name}</h2>
              {p.active_deliveries > 0 && <span className="text-xs text-amber-300">{p.active_deliveries} en curso</span>}
            </div>
            <div className="mt-2 text-3xl font-semibold tabular-nums text-white">{formatMXN(p.expected_cash)}</div>
            <p className="text-xs text-gray-500">{p.deliveries_count} pedido(s) cobrados sin entregar el efectivo</p>
            {p.payments.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-gray-400">
                {p.payments.map((x) => (
                  <li key={x.id} className="flex justify-between"><span>#{x.folio} · {formatTime(x.created_at)}</span><span>{formatMXN(Number(x.amount) + Number(x.tip))}</span></li>
                ))}
              </ul>
            )}
            <Button className="mt-4 w-full" disabled={p.payments.length === 0 || sessions.length === 0} onClick={() => setCutting(p)}>
              <Wallet className="h-4 w-4" /> Hacer corte
            </Button>
          </section>
        ))}
        {data.pending.length === 0 && <p className="text-sm text-gray-500">No hay repartidores en esta sucursal.</p>}
      </div>

      <h2 className="mb-3 mt-10 text-sm font-medium uppercase tracking-wider text-gray-500">Historial</h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">Fecha</th>
              <th className="px-4 py-3 font-medium">Repartidor</th>
              <th className="px-4 py-3 font-medium">Caja</th>
              <th className="px-4 py-3 text-right font-medium">Esperado</th>
              <th className="px-4 py-3 text-right font-medium">Entregó</th>
              <th className="px-4 py-3 text-right font-medium">Diferencia</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {data.cuts.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-3 text-gray-400">{formatDateTime(c.created_at)}</td>
                <td className="px-4 py-3 text-gray-200">{c.driver_name}<span className="block text-xs text-gray-500">{c.deliveries_count} pedido(s) · {c.created_by_name}</span></td>
                <td className="px-4 py-3 text-gray-400">{c.terminal}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(c.expected_cash)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMXN(c.counted_cash)}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${Number(c.difference) < 0 ? 'text-red-300' : Number(c.difference) > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{formatMXN(c.difference)}</td>
              </tr>
            ))}
            {data.cuts.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Sin cortes todavía.</td></tr>}
          </tbody>
        </table>
      </div>

      {cutting && (
        <CutModal pending={cutting} sessions={sessions} branchId={branchId} onClose={() => setCutting(null)}
          onDone={(msg) => { setCutting(null); setNotice(msg); load(); }} />
      )}
    </>
  );
}

function CutModal({ pending, sessions, branchId, onClose, onDone }: {
  pending: PendingCut; sessions: CashSession[]; branchId: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const preferred = sessions.find((s) => s.terminal.toLowerCase() === posPrefs.getTerminal().toLowerCase()) || sessions[0];
  const [sessionId, setSessionId] = useState(preferred?.id || '');
  const [counted, setCounted] = useState(String(pending.expected_cash));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const diff = Math.round((Number(counted || 0) - pending.expected_cash) * 100) / 100;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/delivery/driver-cuts', {
        method: 'POST',
        body: { branch_id: branchId, driver_user_id: pending.driver_user_id, cash_session_id: sessionId, counted_cash: Number(counted || 0), notes: notes || undefined },
      });
      onDone(`Corte de ${pending.name} registrado.`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={`Corte de ${pending.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-300">Debe entregar <b className="text-xl text-white">{formatMXN(pending.expected_cash)}</b> ({pending.deliveries_count} pedido(s), con propinas).</p>
        <Field label="Caja que recibe el efectivo">
          <select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.terminal}</option>)}
          </select>
        </Field>
        <Field label="Efectivo que entrega">
          <input className="input" type="number" min="0" step="0.01" required value={counted} onChange={(e) => setCounted(e.target.value)} />
        </Field>
        {diff !== 0 && <p className={`text-sm ${diff < 0 ? 'text-red-300' : 'text-amber-300'}`}>{diff < 0 ? 'Faltante' : 'Sobrante'}: {formatMXN(Math.abs(diff))}</p>}
        <Field label="Notas (opcional)"><input className="input" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></Field>
        <Button type="submit" className="w-full" loading={saving}>Registrar corte</Button>
      </form>
    </Modal>
  );
}
