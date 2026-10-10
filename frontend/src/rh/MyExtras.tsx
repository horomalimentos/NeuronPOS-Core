import { MessageSquareWarning } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { CLAIM_KIND_LABEL, DAY_STATUS_LABEL, DAY_STATUS_STYLE, hours, shortDay, todayStr } from './lib';
import { ClaimBadge } from './PayrollExtras';
import type { AguinaldoRow, ClaimKind, LiveItem, PayrollClaim } from './types';

/** Lo que va de mi periodo en curso (prenomina en vivo, no es definitivo). */
export function MyLive({ onClaim }: { onClaim: (date: string) => void }) {
  const [data, setData] = useState<{ today: string; item: LiveItem | undefined } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ today: string; item: LiveItem | undefined }>('/rh/me/live').then(setData).catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <section className="card p-5"><Alert>{error}</Alert></section>;
  if (!data) return <section className="card p-5"><Spinner /></section>;
  const it = data.item;
  if (!it) return null;
  return (
    <section className="card p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-white">Mi periodo en curso</h2>
        <span className="text-xs text-gray-500">{formatDay(it.start_date)} al {formatDay(it.end_date)}</span>
      </div>
      {it.no_salary ? <p className="text-sm text-gray-500">Tu salario aún no está capturado.</p> : (
        <>
          <p className="mb-3 text-sm text-gray-400">
            Llevas <span className="font-semibold text-white">{formatMXN(it.net ?? 0)}</span> neto · {it.days_worked} día(s) · {hours(it.minutes_worked ?? 0)}
            {(it.tardies ?? 0) > 0 && ` · ${it.tardies} retardo(s)`}{(it.absences ?? 0) > 0 && ` · ${it.absences} falta(s)`}
          </p>
          <ul className="space-y-1 text-sm">
            {(it.days ?? []).filter((d) => d.date <= data.today).map((d) => (
              <li key={d.date} className="flex items-center justify-between gap-2">
                <span className="text-gray-400">{shortDay(d.date)}</span>
                <span className="flex items-center gap-2">
                  <span className={DAY_STATUS_STYLE[d.status]}>{DAY_STATUS_LABEL[d.status]}{d.tardy && ` · ${d.late_minutes} min tarde`}</span>
                  {(d.status === 'falta' || d.tardy) && (
                    <button className="text-xs text-brand hover:underline" onClick={() => onClaim(d.date)}>Aclarar</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-gray-500">Es un cálculo preliminar; el pago final sale en tu recibo.</p>
        </>
      )}
    </section>
  );
}

/** Mis aclaraciones y su respuesta. */
export function MyClaims({ refreshKey, onNew }: { refreshKey: number; onNew: () => void }) {
  const [claims, setClaims] = useState<PayrollClaim[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ claims: PayrollClaim[] }>('/rh/me/claims').then((r) => setClaims(r.claims)).catch((e) => setError(errorMessage(e)));
  }, [refreshKey]);
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-white">Mis aclaraciones</h2>
        <Button variant="secondary" onClick={onNew}><MessageSquareWarning className="h-4 w-4" /> Nueva</Button>
      </div>
      {error ? <Alert>{error}</Alert> : !claims ? <Spinner /> : claims.length === 0 ? (
        <p className="text-sm text-gray-500">Si algo de tu asistencia o tu recibo no cuadra, pide una aclaración y tu gerente te responde aquí.</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {claims.map((c) => (
            <li key={c.id} className="rounded-lg border border-gray-800 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-white">{CLAIM_KIND_LABEL[c.kind]} · {c.date ? shortDay(c.date) : c.period_start ? `Recibo ${formatDay(c.period_start)}` : ''}</span>
                <ClaimBadge status={c.status} />
              </div>
              <p className="mt-1 text-gray-400">{c.description}{c.amount && ` (${formatMXN(c.amount)})`}</p>
              {c.response && <p className="mt-2 border-l-2 border-gray-700 pl-2 text-gray-300">{c.response}<span className="block text-xs text-gray-500">{c.resolved_by_name}</span></p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Mi aguinaldo del año (proporcional si entre en el año). */
export function MyAguinaldo() {
  type Mine = Omit<AguinaldoRow, 'payment'> & { year: number; paid: { amount: string; paid_at: string } | null };
  const [data, setData] = useState<Mine | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ aguinaldo: Mine | null }>('/rh/me/aguinaldo').then((r) => setData(r.aguinaldo)).catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <section className="card p-5"><Alert>{error}</Alert></section>;
  if (data === undefined) return <section className="card p-5"><Spinner /></section>;
  if (!data) return null;
  return (
    <section className="card p-5">
      <h2 className="mb-1 font-semibold text-white">Mi aguinaldo {data.year}</h2>
      <p className="text-2xl font-semibold text-white">{formatMXN(data.paid ? data.paid.amount : data.amount)}</p>
      <p className="mt-1 text-sm text-gray-400">
        {data.paid ? `Pagado el ${formatDay(data.paid.paid_at.slice(0, 10))}` : 'Estimado al cierre del año'}
      </p>
      <p className="mt-2 text-xs text-gray-500">
        {data.aguinaldo_days} días de salario ({formatMXN(data.daily_base)} diarios){data.proportional && `, proporcional a ${data.days_counted} días trabajados en el año`}. Se paga a más tardar el 20 de diciembre.
      </p>
    </section>
  );
}

const KINDS = Object.entries(CLAIM_KIND_LABEL) as [ClaimKind, string][];

/** Nueva aclaracion: de un dia (asistencia) o de un recibo. */
export function ClaimModal({ itemId, date: initialDate, onClose, onSaved }: {
  itemId?: string; date?: string; onClose: () => void; onSaved: () => void;
}) {
  const today = todayStr();
  const [date, setDate] = useState(initialDate ?? todayStr(-1));
  const [kind, setKind] = useState<ClaimKind>(itemId ? 'pago' : 'falta');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/rh/me/claims', {
        method: 'POST',
        body: { ...(itemId ? { item_id: itemId } : { date }), kind, description, ...(amount ? { amount: Number(amount) } : {}) },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }, [itemId, date, kind, description, amount, onSaved, onClose]);
  return (
    <Modal title={itemId ? 'Aclaración de mi recibo' : 'Pedir aclaración'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {itemId && <Alert kind="warning">Mientras tu aclaración esté pendiente no puedes firmar este recibo.</Alert>}
        {!itemId && (
          <Field label="Día">
            <input className="input" type="date" required max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
        <Field label="¿Qué no cuadra?">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ClaimKind)}>
            {KINDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Explícalo" hint="Mínimo 10 caracteres.">
          <textarea className="input min-h-24" required minLength={10} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Monto (opcional)" hint="Si reclamas un pago o descuento, ¿de cuánto?">
          <input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Enviar</Button>
        </div>
      </form>
    </Modal>
  );
}
