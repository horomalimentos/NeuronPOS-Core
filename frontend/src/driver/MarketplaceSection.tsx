import {
  Banknote, Check, CreditCard, History, MapPin, Navigation, Phone, Store, Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Modal } from '../components/ui';
import { telHref } from '../delivery/lib';
import { errorMessage, fleetApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';
import { ChatButton } from '../marketplace/OrderChat';

const POLL_MS = 15000;
const LINK = 'inline-flex items-center gap-1.5 rounded-xl border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800';

interface Offer {
  id: string; restaurant_name: string; pickup_address: string | null; status: string; distance_km: number;
  driver_share: string; payment_method: 'efectivo' | 'tarjeta'; food_total: string; collect: string;
  estimated_ready_at: string | null; created_at: string;
}
interface Job extends Offer {
  folio: number; pickup_phone: string | null; pickup_maps_url: string | null; customer_name: string; customer_phone: string;
  address: string; reference: string | null; dropoff_maps_url: string; pay_with: string | null; change: number | null;
  total: string; delivery_fee: string; platform_share: string; picked_up_at: string | null; messages: number;
}
interface Board {
  balance: number; debt_limit: number; cash_blocked: boolean; card_payments: boolean;
  today: { deliveries: number; earned: string }; active: Job[]; available: Offer[];
}
interface Entry { id: string; kind: string; amount: string; note: string | null; created_at: string }

const KIND_LABEL: Record<string, string> = {
  comision_efectivo: 'Parte de NeuronPOS (efectivo)',
  abono_tarjeta: 'Abono por pedido con tarjeta',
  pago_clip: 'Pago con tarjeta',
  pago_efectivo: 'Pago en efectivo',
  liquidacion: 'Te pagamos tu saldo',
  ajuste: 'Ajuste',
};

/**
 * NeuronPOS Delivery en la app del repartidor: su cuenta con NeuronPOS
 * (adeudo del 20 % de los envios en efectivo, abonos de los pedidos con
 * tarjeta), el pedido que lleva y los pedidos disponibles de su zona.
 */
export default function MarketplaceSection({ onDuty }: { onDuty: boolean }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [ledger, setLedger] = useState<Entry[] | null>(null);
  const [paying, setPaying] = useState(false);
  const back = new URLSearchParams(window.location.search).get('pago');

  const load = useCallback(() => {
    fleetApi<Board>('/fleet/marketplace').then((b) => { setBoard(b); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load, onDuty]);

  async function act(key: string, path: string) {
    setBusy(key);
    setError('');
    try {
      await fleetApi(path, { method: 'POST' });
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy('');
    load();
  }

  if (!board) return error ? <Alert>{error}</Alert> : null;
  const debt = board.balance < 0 ? -board.balance : 0;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">NeuronPOS Delivery</h2>
      {error && <Alert>{error}</Alert>}
      {back === 'ok' && <Alert kind="success">Recibimos tu pago. Tu saldo se actualiza en cuanto Clip lo confirma.</Alert>}

      <div className={`card p-4 ${board.cash_blocked ? 'border-red-700/60' : ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-gray-400"><Wallet className="h-4 w-4" /> Mi cuenta con NeuronPOS</div>
            <div className={`mt-1 text-2xl font-semibold ${debt > 0 ? 'text-amber-300' : 'text-white'}`}>
              {debt > 0 ? `Debes ${formatMXN(debt)}` : board.balance > 0 ? `A tu favor ${formatMXN(board.balance)}` : 'Sin adeudo'}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Hoy: {board.today.deliveries} entregas · ganaste {formatMXN(board.today.earned)} de envío
            </p>
          </div>
          <button type="button" onClick={() => fleetApi<{ entries: Entry[] }>('/fleet/marketplace/ledger').then((r) => setLedger(r.entries)).catch((e) => setError(errorMessage(e)))}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-white"><History className="h-4 w-4" /> Movimientos</button>
        </div>
        {board.cash_blocked && (
          <p className="mt-2 text-sm text-red-300">Tu adeudo llegó al tope de {formatMXN(board.debt_limit)}: paga para volver a tomar pedidos en efectivo. Los de tarjeta sí los puedes tomar.</p>
        )}
        {debt > 0 && board.card_payments && (
          <Button className="mt-3 w-full" variant="secondary" onClick={() => setPaying(true)}><CreditCard className="h-4 w-4" /> Pagar con tarjeta</Button>
        )}
      </div>

      {board.active.map((j) => (
        <article key={j.id} className="card border-brand/60 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">#{j.folio} · {j.restaurant_name}</span>
            <span className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-300">{j.status === 'en_camino' ? 'En camino' : j.status === 'listo' ? 'Listo para recoger' : 'En preparación'}</span>
          </div>
          {j.status !== 'en_camino' ? (
            <div className="mt-2 space-y-1 text-gray-300">
              <p className="flex items-center gap-2"><Store className="h-4 w-4 text-gray-500" /> Recoge en {j.pickup_address}</p>
              {j.estimated_ready_at && <p className="text-xs text-gray-500">Listo cerca de las {formatTime(j.estimated_ready_at)}</p>}
              <p className="rounded-lg bg-amber-950/40 px-3 py-2 text-amber-200">Paga {formatMXN(j.food_total)} de la comida en el restaurante.</p>
              <div className="flex flex-wrap gap-2 pt-1">
                {j.pickup_maps_url && <a className={LINK} href={j.pickup_maps_url} target="_blank" rel="noreferrer"><Navigation className="h-4 w-4" /> Cómo llegar</a>}
                {j.pickup_phone && <a className={LINK} href={telHref(j.pickup_phone)}><Phone className="h-4 w-4" /> Restaurante</a>}
                <ChatButton chatKey={`d:${j.id}`} count={j.messages} title={`Chat del pedido #${j.folio}`} me="repartidor"
                  path={`/fleet/marketplace/orders/${j.id}/messages`} call={fleetApi} />
              </div>
            </div>
          ) : (
            <div className="mt-2 space-y-1 text-gray-300">
              <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-gray-500" /> {j.customer_name} · {j.address}{j.reference && ` (${j.reference})`}</p>
              {j.payment_method === 'efectivo' ? (
                <p className="rounded-lg bg-amber-950/40 px-3 py-2 text-amber-200">
                  Cobra {formatMXN(j.total)} en efectivo{j.change !== null && j.change > 0 && ` · paga con ${formatMXN(j.pay_with)}, lleva ${formatMXN(j.change)} de cambio`}
                </p>
              ) : (
                <p className="rounded-lg bg-emerald-950/40 px-3 py-2 text-emerald-200">Pagado con tarjeta: no cobres nada. Te abonamos {formatMXN(Number(j.food_total) + Number(j.driver_share))}.</p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <a className={LINK} href={j.dropoff_maps_url} target="_blank" rel="noreferrer"><Navigation className="h-4 w-4" /> Cómo llegar</a>
                <a className={LINK} href={telHref(j.customer_phone)}><Phone className="h-4 w-4" /> Cliente</a>
                <ChatButton chatKey={`d:${j.id}`} count={j.messages} title={`Chat del pedido #${j.folio}`} me="repartidor"
                  path={`/fleet/marketplace/orders/${j.id}/messages`} call={fleetApi} />
              </div>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            {j.status !== 'en_camino' ? (
              <>
                <Button className="flex-1" loading={busy === `pickup:${j.id}`} onClick={() => act(`pickup:${j.id}`, `/fleet/marketplace/orders/${j.id}/pickup`)}>
                  <Banknote className="h-4 w-4" /> Recogí y pagué la comida
                </Button>
                <Button variant="secondary" loading={busy === `release:${j.id}`} onClick={() => act(`release:${j.id}`, `/fleet/marketplace/orders/${j.id}/release`)}>Soltar</Button>
              </>
            ) : (
              <Button className="flex-1" loading={busy === `deliver:${j.id}`} onClick={() => act(`deliver:${j.id}`, `/fleet/marketplace/orders/${j.id}/deliver`)}>
                <Check className="h-4 w-4" /> Entregado
              </Button>
            )}
          </div>
        </article>
      ))}

      {board.active.length === 0 && (onDuty ? (
        board.available.length === 0 ? (
          <p className="card p-5 text-center text-sm text-gray-500">No hay pedidos disponibles en tu zona por ahora.</p>
        ) : board.available.map((o) => (
          <article key={o.id} className="card border-violet-700/60 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white">{o.restaurant_name}</span>
              <span className="font-semibold text-emerald-300">Ganas {formatMXN(o.driver_share)}</span>
            </div>
            <p className="text-gray-400">Recoger en {o.pickup_address} · entrega a {o.distance_km.toFixed(1)} km</p>
            <p className="mt-1 text-gray-300">
              {o.payment_method === 'efectivo'
                ? <>Pagas {formatMXN(o.food_total)} en el restaurante y cobras {formatMXN(o.collect)} al cliente.</>
                : <>Con tarjeta: pagas {formatMXN(o.food_total)} en el restaurante y te lo abonamos con tu envío.</>}
            </p>
            {o.estimated_ready_at && <p className="text-xs text-gray-500">Listo cerca de las {formatTime(o.estimated_ready_at)}</p>}
            <Button className="mt-3 w-full" loading={busy === `take:${o.id}`} onClick={() => act(`take:${o.id}`, `/fleet/marketplace/orders/${o.id}/take`)}>Tomar pedido</Button>
          </article>
        ))
      ) : (
        <p className="card p-5 text-center text-sm text-gray-500">Activa "En turno" para ver los pedidos de tu zona.</p>
      ))}

      {ledger && (
        <Modal title="Movimientos" onClose={() => setLedger(null)}>
          {ledger.length === 0 ? <p className="text-sm text-gray-400">Todavía no tienes movimientos.</p> : (
            <ul className="divide-y divide-gray-800 text-sm">
              {ledger.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <div className="text-gray-200">{KIND_LABEL[e.kind] || e.kind}</div>
                    {e.note && <div className="text-xs text-gray-500">{e.note}</div>}
                    <div className="text-xs text-gray-600">{new Date(e.created_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</div>
                  </div>
                  <span className={Number(e.amount) < 0 ? 'text-amber-300' : 'text-emerald-300'}>{formatMXN(e.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
      {paying && <PayDebt debt={debt} onClose={() => setPaying(false)} />}
    </section>
  );
}

function PayDebt({ debt, onClose }: { debt: number; onClose: () => void }) {
  const [amount, setAmount] = useState(debt.toFixed(2));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function pay() {
    setBusy(true);
    setError('');
    try {
      const r = await fleetApi<{ payment_url: string }>('/fleet/marketplace/pay-debt', { method: 'POST', body: { amount: Number(amount) } });
      window.location.assign(r.payment_url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Pagar adeudo" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-400">Debes {formatMXN(debt)}. Puedes pagar todo o una parte con tarjeta (Clip).</p>
        <Field label="Monto"><input className="input" type="number" min={1} max={debt} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {error && <Alert>{error}</Alert>}
        <Button className="w-full" loading={busy} onClick={pay}><CreditCard className="h-4 w-4" /> Ir a pagar</Button>
      </div>
    </Modal>
  );
}
