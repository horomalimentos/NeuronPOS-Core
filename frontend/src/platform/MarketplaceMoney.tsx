import { Receipt, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatMXN } from '../lib/format';

interface Balance {
  id: string; name: string; phone: string; status: string; on_duty: boolean; balance: string; entries: number;
  last_entry_at: string | null; deliveries: number;
}
interface Entry { id: string; kind: string; amount: string; note: string | null; created_at: string; created_by_name: string | null }
interface PanelOrder {
  id: string; folio: number; status: string; restaurant_name: string; branch_name: string; customer_name: string;
  distance_km: string; food_total: string; delivery_fee: string; driver_share: string; platform_share: string; total: string;
  payment_method: 'efectivo' | 'tarjeta'; paid_at: string | null; cancel_reason: string | null; driver_name: string | null;
  created_at: string; refund_needed: boolean; clip_reference: string | null;
}

const LEDGER_KIND_LABEL: Record<string, string> = {
  comision_efectivo: 'Parte de NeuronPOS (efectivo)',
  abono_tarjeta: 'Abono pedido con tarjeta',
  pago_clip: 'Pagó con tarjeta',
  pago_efectivo: 'Pagó en efectivo',
  liquidacion: 'Liquidación',
  ajuste: 'Ajuste',
};
const ORDER_STATUS_LABEL: Record<string, string> = {
  pago_pendiente: 'Esperando pago', nuevo: 'Nuevo', aceptado: 'En preparación', listo: 'Listo', en_camino: 'En camino',
  entregado: 'Entregado', rechazado: 'Rechazado', cancelado: 'Cancelado',
};
const when = (d: string) => new Date(d).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Panel › Delivery: cuenta de cada repartidor con NeuronPOS. Saldo negativo =
 * debe la parte de NeuronPOS de sus envios en efectivo; positivo = se le
 * debe (pedidos con tarjeta). Aqui se registran sus pagos en efectivo, las
 * liquidaciones y los ajustes.
 */
export function DriverAccountsCard() {
  const [data, setData] = useState<{ drivers: Balance[]; debt_limit: number } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Balance | null>(null);
  const load = useCallback(() => {
    platformApi<{ drivers: Balance[]; debt_limit: number }>('/platform/marketplace/balances').then(setData).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const owed = (data?.drivers || []).reduce((s, d) => s + Math.max(0, -Number(d.balance)), 0);
  const credit = (data?.drivers || []).reduce((s, d) => s + Math.max(0, Number(d.balance)), 0);
  return (
    <section className="card mt-6 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-white"><Wallet className="h-5 w-5 text-brand" /> Cuentas de repartidores</h2>
        {data && <p className="text-sm text-gray-400">Te deben {formatMXN(owed)} · Debes {formatMXN(credit)}</p>}
      </div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : data.drivers.length === 0 ? <p className="py-6 text-center text-sm text-gray-500">Sin repartidores todavía.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="py-2">Repartidor</th><th>Entregas</th><th className="text-right">Saldo</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.drivers.map((d) => {
                const b = Number(d.balance);
                const blocked = b < 0 && -b >= data.debt_limit;
                return (
                  <tr key={d.id}>
                    <td className="py-3 pr-3"><div className="font-medium text-white">{d.name}</div><div className="text-xs text-gray-400">{d.phone}</div></td>
                    <td className="py-3 pr-3 text-gray-300">{d.deliveries}</td>
                    <td className={`py-3 pr-3 text-right font-medium ${b < 0 ? 'text-amber-300' : b > 0 ? 'text-emerald-300' : 'text-gray-400'}`}>
                      {b < 0 ? `Debe ${formatMXN(-b)}` : b > 0 ? `A favor ${formatMXN(b)}` : '—'}
                      {blocked && <div className="text-xs text-red-300">Tope: sin efectivo</div>}
                    </td>
                    <td className="py-3 text-right"><Button variant="secondary" className="px-3 py-1.5" onClick={() => setOpen(d)}>Ver cuenta</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <LedgerModal driver={open} onClose={() => setOpen(null)} onChange={load} />}
    </section>
  );
}

function LedgerModal({ driver, onClose, onChange }: { driver: Balance; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<{ balance: string; entries: Entry[] } | null>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ kind: 'pago_efectivo', amount: '', note: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    platformApi<{ balance: string; entries: Entry[] }>(`/platform/marketplace/drivers/${driver.id}/ledger`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [driver.id]);
  useEffect(load, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await platformApi(`/platform/marketplace/drivers/${driver.id}/ledger`, {
        method: 'POST', body: { kind: f.kind, amount: Number(f.amount), note: f.note || null },
      });
      setF({ ...f, amount: '', note: '' });
      load();
      onChange();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  const b = Number(data?.balance ?? 0);
  return (
    <Modal title={`Cuenta de ${driver.name}`} onClose={onClose} wide>
      {!data ? <Spinner /> : (
        <div className="space-y-4">
          <p className={`text-xl font-semibold ${b < 0 ? 'text-amber-300' : 'text-white'}`}>
            {b < 0 ? `Debe ${formatMXN(-b)}` : b > 0 ? `Se le deben ${formatMXN(b)}` : 'Sin saldo'}
          </p>
          <form onSubmit={save} className="grid gap-2 rounded-xl bg-gray-950/60 p-3 sm:grid-cols-[1fr_8rem_1fr_auto] sm:items-end">
            <Field label="Movimiento">
              <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="pago_efectivo">Pagó su adeudo en efectivo</option>
                <option value="liquidacion">Le pagué su saldo a favor</option>
                <option value="ajuste">Ajuste (+ o −)</option>
              </select>
            </Field>
            <Field label="Monto"><input className="input" type="number" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Nota"><input className="input" maxLength={300} required={f.kind === 'ajuste'} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Transferencia, recibo…" /></Field>
            <Button type="submit" loading={busy}>Registrar</Button>
          </form>
          {error && <Alert>{error}</Alert>}
          {data.entries.length === 0 ? <p className="text-sm text-gray-500">Sin movimientos.</p> : (
            <ul className="max-h-80 divide-y divide-gray-800 overflow-y-auto text-sm">
              {data.entries.map((x) => (
                <li key={x.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <div className="text-gray-200">{LEDGER_KIND_LABEL[x.kind] || x.kind}</div>
                    {x.note && <div className="text-xs text-gray-500">{x.note}</div>}
                    <div className="text-xs text-gray-600">{when(x.created_at)}{x.created_by_name && ` · ${x.created_by_name}`}</div>
                  </div>
                  <span className={Number(x.amount) < 0 ? 'text-amber-300' : 'text-emerald-300'}>{formatMXN(x.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

const ORDER_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'Todos' },
  { key: 'en_camino', label: 'En camino' },
  { key: 'entregado', label: 'Entregados' },
  { key: 'reembolsar', label: 'Por reembolsar' },
];

/** Panel › Delivery: pedidos de todos los restaurantes y los pagados con tarjeta que hay que reembolsar. */
export function MarketplaceOrdersCard() {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<PanelOrder[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    platformApi<{ orders: PanelOrder[] }>(`/platform/marketplace/orders${filter ? `?status=${filter}` : ''}`)
      .then((r) => setRows(r.orders)).catch((e) => setError(errorMessage(e)));
  }, [filter]);

  return (
    <section className="card mt-6 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-white"><Receipt className="h-5 w-5 text-brand" /> Pedidos</h2>
        <div className="flex gap-1">
          {ORDER_FILTERS.map((x) => (
            <button key={x.key} type="button" onClick={() => setFilter(x.key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${filter === x.key ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>{x.label}</button>
          ))}
        </div>
      </div>
      {filter === 'reembolsar' && <p className="mb-3 text-sm text-gray-400">Pagados con tarjeta y luego rechazados o cancelados: reembólsalos desde el panel de Clip con la referencia.</p>}
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-gray-500">Sin pedidos.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="py-2">Pedido</th><th>Repartidor</th><th>Pago</th><th className="text-right">Comida</th><th className="text-right">Envío</th><th className="text-right">NeuronPOS</th><th>Estado</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((o) => (
                <tr key={o.id} className="align-top">
                  <td className="py-3 pr-3">
                    <div className="font-medium text-white">#{o.folio} · {o.restaurant_name}</div>
                    <div className="text-xs text-gray-400">{o.customer_name} · {when(o.created_at)} · {Number(o.distance_km).toFixed(1)} km</div>
                  </td>
                  <td className="py-3 pr-3 text-gray-300">{o.driver_name || '—'}</td>
                  <td className="py-3 pr-3 text-gray-300">{o.payment_method === 'tarjeta' ? 'Tarjeta' : 'Efectivo'}{o.clip_reference && <div className="text-xs text-gray-500">{o.clip_reference}</div>}</td>
                  <td className="py-3 pr-3 text-right text-gray-300">{formatMXN(o.food_total)}</td>
                  <td className="py-3 pr-3 text-right text-gray-300">{formatMXN(o.delivery_fee)}</td>
                  <td className="py-3 pr-3 text-right text-gray-300">{formatMXN(o.platform_share)}</td>
                  <td className="py-3">
                    <span className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-200">{ORDER_STATUS_LABEL[o.status] || o.status}</span>
                    {o.refund_needed && <div className="mt-1 text-xs text-red-300">Reembolsar {formatMXN(o.total)}</div>}
                    {o.cancel_reason && <div className="mt-1 max-w-[12rem] text-xs text-gray-500">{o.cancel_reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
