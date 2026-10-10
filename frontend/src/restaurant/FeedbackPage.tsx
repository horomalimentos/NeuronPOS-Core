import { CheckCircle2, MessageSquareWarning, Star, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { Stat } from '../pos/ReportsPage';
import { useAdmin } from './context';

interface RatingRow {
  id: string; overall: number; food: number | null; service: number | null; comment: string | null; created_at: string;
  folio: number; customer_name: string | null; public_token: string; branch_name: string;
}
interface Summary {
  days: number; count: number;
  average: { overall: number | null; food: number | null; service: number | null };
  distribution: number[];
  by_branch: { branch_id: string; branch_name: string; count: number; overall: number }[];
  recent: RatingRow[];
}
type ComplaintStatus = 'pendiente' | 'aprobada' | 'rechazada';
interface Complaint {
  id: string; status: ComplaintStatus; reason: string; created_at: string; folio: number; order_type: string; total: string;
  branch_name: string; contact_name: string | null; contact_phone: string | null; contact_email: string | null; customer_id: string | null;
  items: { order_item_id: string; name: string; quantity: number }[]; evidence_urls: string[];
  rating_overall: number | null; rating_comment: string | null;
  reviewed_at: string | null; reviewed_by_name: string | null; review_notes: string | null; responsible_name: string | null;
  compensation_type: 'ninguna' | 'monedero' | 'puntos'; compensation_amount: string | null; compensation_points: number | null;
  employee_charge: string | null;
}
interface Options { wallet: boolean; points: boolean; payroll: boolean; employees: { id: string; full_name: string; position: string | null }[] }

const STATUS: Record<ComplaintStatus, { label: string; tone: string }> = {
  pendiente: { label: 'Pendiente', tone: 'bg-amber-500/15 text-amber-300' },
  aprobada: { label: 'Aprobada', tone: 'bg-emerald-500/15 text-emerald-300' },
  rechazada: { label: 'Rechazada', tone: 'bg-gray-700 text-gray-300' },
};

const avg = (n: number | null) => (n == null ? '—' : n.toFixed(1));

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex" aria-label={`${value} de 5 estrellas`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={`h-4 w-4 ${n <= value ? 'fill-amber-400 text-amber-400' : 'text-gray-600'}`} />)}
    </span>
  );
}

/** Calificaciones de los pedidos en linea y quejas de clientes (modulo quejas). */
export default function FeedbackPage() {
  const { me } = useAdmin();
  const [tab, setTab] = useState<'quejas' | 'calificaciones'>('quejas');
  const [branch, setBranch] = useState('');
  const [pending, setPending] = useState<number | null>(null);

  return (
    <>
      <PageHeader title="Calificaciones y quejas" subtitle="Lo que opinan tus clientes de sus pedidos en línea."
        actions={me.branches.length > 1 && (
          <select className="input w-auto" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Sucursal">
            <option value="">Todas las sucursales</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )} />
      <div className="mb-6 flex gap-1 border-b border-gray-800">
        {([['quejas', 'Quejas', MessageSquareWarning], ['calificaciones', 'Calificaciones', Star]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
            <Icon className="h-4 w-4" /> {label}
            {k === 'quejas' && pending ? <span className="rounded-full bg-amber-500 px-1.5 text-xs font-bold text-gray-900">{pending}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'quejas' ? <Complaints branch={branch} onPending={setPending} /> : <Ratings branch={branch} />}
    </>
  );
}

function Ratings({ branch }: { branch: string }) {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ summary: Summary }>(`/feedback/ratings?days=${days}${branch ? `&branch_id=${branch}` : ''}`)
      .then((r) => { setS(r.summary); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, [days, branch]);

  if (error) return <Alert>{error}</Alert>;
  if (!s) return <Spinner />;
  const max = Math.max(1, ...s.distribution);
  return (
    <div className="space-y-6">
      <div className="flex gap-1">
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`rounded-lg px-3 py-1.5 text-sm ${days === d ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
            {d} días
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Promedio general" value={s.count ? `${avg(s.average.overall)} ★` : '—'} extra={<span className="text-xs text-gray-500">{s.count} calificaciones</span>} />
        <Stat label="Comida" value={s.average.food == null ? '—' : `${avg(s.average.food)} ★`} />
        <Stat label="Servicio" value={s.average.service == null ? '—' : `${avg(s.average.service)} ★`} />
        <div className="card p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Estrellas</p>
          <ul className="mt-2 space-y-1">
            {[5, 4, 3, 2, 1].map((n) => (
              <li key={n} className="flex items-center gap-2 text-xs text-gray-400">
                <span className="w-3 text-right tabular-nums">{n}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-800">
                  <span className="block h-full rounded-full bg-amber-400" style={{ width: `${(s.distribution[n - 1] / max) * 100}%` }} />
                </span>
                <span className="w-6 tabular-nums">{s.distribution[n - 1]}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {s.by_branch.length > 1 && (
        <div className="card divide-y divide-gray-800">
          {s.by_branch.map((b) => (
            <div key={b.branch_id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="text-white">{b.branch_name}</span>
              <span className="text-gray-400">{avg(b.overall)} ★ · {b.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card divide-y divide-gray-800">
        {s.recent.length === 0 ? <p className="p-6 text-center text-sm text-gray-500">Todavía no hay calificaciones en este periodo.</p>
          : s.recent.map((r) => (
            <div key={r.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Stars value={r.overall} />
                <span className="text-sm text-white">Pedido #{r.folio}</span>
                <span className="text-xs text-gray-500">{r.customer_name || 'Cliente'} · {r.branch_name} · {formatDateTime(r.created_at)}</span>
              </div>
              {(r.food || r.service) && (
                <p className="mt-1 text-xs text-gray-500">{r.food ? `Comida ${r.food}★` : ''}{r.food && r.service ? ' · ' : ''}{r.service ? `Servicio ${r.service}★` : ''}</p>
              )}
              {r.comment && <p className="mt-1 text-sm text-gray-300">“{r.comment}”</p>}
            </div>
          ))}
      </div>
    </div>
  );
}

function Complaints({ branch, onPending }: { branch: string; onPending: (n: number) => void }) {
  const [status, setStatus] = useState<ComplaintStatus | ''>('pendiente');
  const [list, setList] = useState<Complaint[] | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState<Complaint | null>(null);
  const [rejecting, setRejecting] = useState<Complaint | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (branch) q.set('branch_id', branch);
    api<{ complaints: Complaint[]; pending_count: number; options: Options }>(`/feedback/complaints?${q}`)
      .then((r) => { setList(r.complaints); setOptions(r.options); onPending(r.pending_count); setError(''); })
      .catch((e) => setError(errorMessage(e)));
  }, [status, branch, onPending]);
  useEffect(load, [load]);

  const done = () => { setApproving(null); setRejecting(null); load(); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {([['pendiente', 'Pendientes'], ['aprobada', 'Aprobadas'], ['rechazada', 'Rechazadas'], ['', 'Todas']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setStatus(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${status === k ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>
      {error && <Alert>{error}</Alert>}
      {!list ? <Spinner /> : list.length === 0 ? (
        <p className="card p-8 text-center text-sm text-gray-500">{status === 'pendiente' ? 'No hay quejas pendientes.' : 'No hay quejas.'}</p>
      ) : list.map((c) => (
        <div key={c.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-white">Pedido #{c.folio}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[c.status].tone}`}>{STATUS[c.status].label}</span>
                {c.rating_overall && <Stars value={c.rating_overall} />}
              </div>
              <p className="mt-0.5 text-xs text-gray-500">
                {c.contact_name || 'Cliente'}{c.contact_phone && ` · ${c.contact_phone}`}{c.contact_email && ` · ${c.contact_email}`}
                {!c.customer_id && ' · invitado'} · {c.branch_name} · {formatMXN(c.total)} · {formatDateTime(c.created_at)}
              </p>
            </div>
            {c.status === 'pendiente' && (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setRejecting(c)}><XCircle className="h-4 w-4" /> Rechazar</Button>
                <Button onClick={() => setApproving(c)}><CheckCircle2 className="h-4 w-4" /> Aprobar</Button>
              </div>
            )}
          </div>
          <p className="mt-3 text-sm text-gray-200">“{c.reason}”</p>
          {c.items.length > 0 && <p className="mt-1 text-xs text-gray-400">Productos: {c.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</p>}
          {c.evidence_urls.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {c.evidence_urls.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="block h-20 w-20 overflow-hidden rounded-lg border border-gray-700">
                  <img src={u} alt="Foto del cliente" className="h-full w-full object-cover" />
                </a>
              ))}
            </div>
          )}
          {c.status !== 'pendiente' && (
            <div className="mt-3 rounded-lg bg-gray-900 p-3 text-xs text-gray-400">
              {c.status === 'aprobada' ? (
                <>
                  Aprobada{c.responsible_name && <> · responsable: <b className="text-gray-200">{c.responsible_name}</b></>}
                  {c.compensation_type === 'monedero' && <> · {formatMXN(c.compensation_amount)} al monedero</>}
                  {c.compensation_type === 'puntos' && <> · {c.compensation_points} puntos</>}
                  {c.employee_charge && <> · descuento en nómina {formatMXN(c.employee_charge)}</>}
                </>
              ) : 'Rechazada'}
              {c.review_notes && <> · “{c.review_notes}”</>}
              <span className="block text-gray-500">{c.reviewed_by_name} · {c.reviewed_at && formatDateTime(c.reviewed_at)}</span>
            </div>
          )}
        </div>
      ))}
      {approving && options && <ApproveModal c={approving} options={options} onClose={() => setApproving(null)} onDone={done} />}
      {rejecting && <RejectModal c={rejecting} onClose={() => setRejecting(null)} onDone={done} />}
    </div>
  );
}

function ApproveModal({ c, options, onClose, onDone }: { c: Complaint; options: Options; onClose: () => void; onDone: () => void }) {
  const guest = !c.customer_id;
  const [employee, setEmployee] = useState('');
  const [comp, setComp] = useState<'ninguna' | 'monedero' | 'puntos'>('ninguna');
  const [amount, setAmount] = useState('');
  const [charge, setCharge] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`/feedback/complaints/${c.id}/approve`, {
        method: 'POST',
        body: {
          responsible_employee_id: employee || null,
          compensation: comp === 'monedero' ? { type: comp, amount: Number(amount) } : comp === 'puntos' ? { type: comp, points: Number(amount) } : { type: 'ninguna' },
          employee_charge: charge ? Number(charge) : null,
          notes: notes.trim() || null,
        },
      });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const compOptions = [
    ['ninguna', 'Sin compensación', true],
    ['monedero', 'Saldo al monedero', options.wallet && !guest],
    ['puntos', 'Puntos de lealtad', options.points && !guest],
  ] as const;

  return (
    <Modal title={`Aprobar queja del pedido #${c.folio}`} onClose={onClose}>
      <div className="space-y-4">
        {options.payroll && (
          <Field label="Empleado responsable (opcional)">
            <select className="input" value={employee} onChange={(e) => { setEmployee(e.target.value); if (!e.target.value) setCharge(''); }}>
              <option value="">Nadie en particular</option>
              {options.employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}{e.position ? ` · ${e.position}` : ''}</option>)}
            </select>
          </Field>
        )}
        <Field label="Compensación al cliente" hint={guest ? 'Pidió como invitado: no tiene monedero ni puntos.' : undefined}>
          <select className="input" value={comp} onChange={(e) => setComp(e.target.value as typeof comp)}>
            {compOptions.filter(([, , ok]) => ok).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        {comp !== 'ninguna' && (
          <Field label={comp === 'monedero' ? 'Monto a abonar ($)' : 'Puntos a regalar'}>
            <input className="input" type="number" min={1} step={comp === 'monedero' ? '0.01' : '1'} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        {options.payroll && employee && (
          <Field label="Descuento en nómina al responsable ($, opcional)" hint="Se agrega como descuento único en su próxima nómina.">
            <input className="input" type="number" min={0} step="0.01" value={charge} onChange={(e) => setCharge(e.target.value)} />
          </Field>
        )}
        <Field label="Nota interna (opcional)">
          <textarea className="input" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="text-xs text-gray-500">{c.contact_email ? `Le avisamos al cliente por correo (${c.contact_email}) y` : 'El cliente'} lo ve en el seguimiento de su pedido.</p>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} loading={busy} disabled={comp !== 'ninguna' && !(Number(amount) > 0)}>Aprobar</Button>
        </div>
      </div>
    </Modal>
  );
}

function RejectModal({ c, onClose, onDone }: { c: Complaint; onClose: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`/feedback/complaints/${c.id}/reject`, { method: 'POST', body: { notes: notes.trim() } });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Rechazar queja del pedido #${c.folio}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Respuesta para el cliente" hint="La ve en el seguimiento de su pedido y le llega por correo si dejó uno.">
          <textarea className="input" rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button variant="danger" onClick={save} loading={busy} disabled={!notes.trim()}>Rechazar</Button>
        </div>
      </div>
    </Modal>
  );
}
