import { ArrowLeft, CreditCard, History, Landmark, LogOut, Wallet, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NayoMark } from '../components/NayoLogo';
import { Alert, Button, Field, Modal, Spinner } from '../components/ui';
import { DELIVERY_STATUS_STYLE } from '../delivery/lib';
import type { DriverJob } from '../delivery/types';
import { errorMessage, fleetApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';
import type { NayoBoard } from './trips';

/** Pantalla completa encima del mapa (Ganancias, Historial). */
export function Screen({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[1200] overflow-y-auto bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-800 bg-gray-950/95 px-4 py-3 backdrop-blur">
        <button type="button" onClick={onClose} className="rounded-full p-2 text-gray-300 hover:bg-gray-800" aria-label="Regresar"><ArrowLeft className="h-5 w-5" /></button>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
      </header>
      <div className="mx-auto max-w-lg space-y-4 p-4 pb-10">{children}</div>
    </div>
  );
}

/** Menu lateral, como el de las apps de reparto. */
export function Drawer({ name, subtitle, nayo, onClose, items, onLogout }: {
  name: string; subtitle: string; nayo: boolean; onClose: () => void; onLogout: () => void;
  items: { icon: ReactNode; label: string; hint?: string; onClick: () => void }[];
}) {
  return (
    <div className="fixed inset-0 z-[1100] flex" role="dialog" aria-modal="true" aria-label="Menú">
      <div className="flex h-full w-80 max-w-[85%] flex-col bg-[#1A1714] text-gray-100 shadow-2xl">
        <div className="flex items-start justify-between p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand text-2xl font-black text-brand-contrast">
              {nayo ? <NayoMark className="h-9 w-auto text-gray-900" /> : (name.trim()[0] || 'R').toUpperCase()}
            </div>
            <div>
              <p className="text-lg font-bold text-white">{name || 'Repartidor'}</p>
              <p className="text-xs text-gray-400">{subtitle}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:bg-gray-800" aria-label="Cerrar menú"><X className="h-5 w-5" /></button>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {items.map((i) => (
            <button key={i.label} type="button" onClick={() => { onClose(); i.onClick(); }}
              className="flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left hover:bg-gray-800">
              <span className="text-gray-400">{i.icon}</span>
              <span className="flex-1">
                <span className="block font-medium text-white">{i.label}</span>
                {i.hint && <span className="block text-xs text-gray-500">{i.hint}</span>}
              </span>
            </button>
          ))}
        </nav>
        <button type="button" onClick={onLogout} className="m-3 flex items-center gap-4 rounded-xl px-3 py-3 text-left text-gray-400 hover:bg-gray-800 hover:text-white">
          <LogOut className="h-5 w-5" /> Cerrar sesión
        </button>
      </div>
      <button type="button" className="flex-1 bg-black/60" onClick={onClose} aria-label="Cerrar menú" />
    </div>
  );
}

interface Entry { id: string; kind: string; amount: string; note: string | null; created_at: string }

const KIND_LABEL: Record<string, string> = {
  comision_efectivo: 'Parte de Nayo (efectivo)',
  abono_tarjeta: 'Abono por pedido con tarjeta',
  pago_clip: 'Pagaste con tarjeta',
  pago_efectivo: 'Pagaste en efectivo',
  liquidacion: 'Te pagamos tu saldo',
  ajuste: 'Ajuste',
};

/**
 * Ganancias: hoy y la semana, el saldo con Nayo (a favor o en contra) con
 * sus movimientos, el efectivo por entregar y pagar el adeudo con tarjeta.
 */
export function Earnings({ board, cashPending, fleetToday, hasBank, onBank, onClose }: {
  board: NayoBoard | null; cashPending: number; fleetToday: number; hasBank: boolean; onBank: () => void; onClose: () => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    if (!board) return;
    fleetApi<{ entries: Entry[] }>('/fleet/marketplace/ledger').then((r) => setEntries(r.entries)).catch((e) => setError(errorMessage(e)));
  }, [board]);
  const debt = board && board.balance < 0 ? -board.balance : 0;
  const today = Number(board?.today.earned ?? 0) + fleetToday;
  return (
    <Screen title="Ganancias" onClose={onClose}>
      <div className="rounded-3xl bg-brand p-5 text-brand-contrast">
        <p className="text-sm font-semibold opacity-80">Hoy</p>
        <p className="text-4xl font-black">{formatMXN(today)}</p>
        {board && <p className="mt-1 text-sm opacity-80">{board.today.deliveries} entregas de Nayo · semana {formatMXN(board.week.earned)} en {board.week.deliveries}</p>}
      </div>

      {board && (
        <section className={`rounded-2xl border p-4 ${board.cash_blocked ? 'border-red-700/60 bg-red-950/30' : 'border-gray-800 bg-gray-900'}`}>
          <p className="flex items-center gap-2 text-sm text-gray-400"><Wallet className="h-4 w-4" /> Saldo con Nayo</p>
          <p className={`mt-1 text-3xl font-bold ${debt > 0 ? 'text-amber-300' : board.balance > 0 ? 'text-emerald-300' : 'text-white'}`}>
            {debt > 0 ? `Debes ${formatMXN(debt)}` : board.balance > 0 ? `A tu favor ${formatMXN(board.balance)}` : 'Estás al corriente'}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            En efectivo te quedas con todo y se te descuenta la parte de Nayo; con tarjeta te abonamos la comida y tu envío.
            {board.debt_limit > 0 && ` Tope de adeudo: ${formatMXN(board.debt_limit)}.`}
          </p>
          {board.cash_blocked && <p className="mt-2 text-sm text-red-300">Llegaste al tope: paga para volver a tomar pedidos en efectivo. Los de tarjeta sí los puedes tomar.</p>}
          {debt > 0 && board.card_payments && (
            <Button className="mt-3 w-full" onClick={() => setPaying(true)}><CreditCard className="h-4 w-4" /> Pagar con tarjeta</Button>
          )}
        </section>
      )}

      {board && (
        <button type="button" onClick={onBank}
          className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm ring-1 ${hasBank ? 'bg-gray-900 text-gray-300 ring-gray-800' : 'bg-brand/15 font-semibold text-brand ring-brand/40'}`}>
          <span className="flex items-center gap-2"><Landmark className="h-4 w-4" /> {hasBank ? 'Datos bancarios para tus depósitos' : 'Agrega tu CLABE para recibir tus depósitos'}</span>
          <span>{hasBank ? 'Cambiar' : 'Agregar'}</span>
        </button>
      )}

      {cashPending > 0 && (
        <Alert kind="warning">Traes {formatMXN(cashPending)} en efectivo de pedidos de la flota por entregar.</Alert>
      )}

      {board && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-gray-500"><History className="h-4 w-4" /> Movimientos</h2>
          {error && <Alert>{error}</Alert>}
          {!entries ? <Spinner /> : entries.length === 0 ? <p className="text-sm text-gray-500">Todavía no tienes movimientos.</p> : (
            <ul className="divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900 text-sm">
              {entries.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="text-gray-200">{KIND_LABEL[e.kind] || e.kind}</div>
                    {e.note && <div className="text-xs text-gray-500">{e.note.replace('parte de NeuronPOS', 'parte de Nayo')}</div>}
                    <div className="text-xs text-gray-600">{new Date(e.created_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</div>
                  </div>
                  <span className={`font-semibold ${Number(e.amount) < 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{formatMXN(e.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {paying && <PayDebt debt={debt} onClose={() => setPaying(false)} />}
    </Screen>
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
        <p className="text-sm text-gray-400">Debes {formatMXN(debt)}. Puedes pagar todo o una parte con tarjeta.</p>
        <Field label="Monto"><input className="input" type="number" min={1} max={debt} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {error && <Alert>{error}</Alert>}
        <Button className="w-full" loading={busy} onClick={pay}><CreditCard className="h-4 w-4" /> Ir a pagar</Button>
      </div>
    </Modal>
  );
}

/** Entregas de hoy (Nayo, flota o restaurante). */
export function TodayHistory({ board, done, onClose }: { board: NayoBoard | null; done: DriverJob[]; onClose: () => void }) {
  const empty = !board?.recent.length && !done.length;
  return (
    <Screen title="Entregas de hoy" onClose={onClose}>
      {empty && <p className="py-10 text-center text-sm text-gray-500">Todavía no tienes entregas hoy.</p>}
      {!!board?.recent.length && (
        <ul className="divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900 text-sm">
          {board.recent.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium text-white">#{r.folio} · {r.restaurant_name}</p>
                <p className="text-xs text-gray-500">{formatTime(r.delivered_at)} · {r.payment_method === 'tarjeta' ? 'Tarjeta' : 'Efectivo'}</p>
              </div>
              <span className="font-semibold text-emerald-300">+{formatMXN(r.driver_share)}</span>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <ul className="divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900 text-sm">
          {done.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-gray-300">#{j.folio} · {j.customer_name}{j.restaurant_name && <span className="text-gray-500"> · {j.restaurant_name}</span>}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${DELIVERY_STATUS_STYLE[j.status]}`}>{j.status_label}</span>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

