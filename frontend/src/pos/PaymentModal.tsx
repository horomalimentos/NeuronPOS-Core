import { CheckCircle2, Plus, Printer, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Modal } from '../components/ui';
import { getNative, nativeInfo } from '../lib/native';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { num, round2 } from './lib';
import type { Order, PaymentMethod } from './types';

interface Line {
  key: number;
  methodId: string;
  amount: string;
  tip: string;
  received: string;
  reference: string;
}

const QUICK_CASH = [50, 100, 200, 500, 1000];
let nextKey = 1;

/**
 * Cobro con uno o varios metodos (cuenta dividida), propina por pago y
 * calculo de cambio en efectivo. Adaptado de POSPaymentModal de NeuronPOS.
 */
export default function PaymentModal({ order, methods, sessionId, onClose, onPaid, onPrint }: {
  order: Order;
  methods: PaymentMethod[];
  sessionId: string;
  onClose: () => void;
  onPaid: (order: Order, change: number) => void;
  onPrint: (order: Order, change: number, opts?: { openDrawer?: boolean }) => void;
}) {
  // Los pagos en línea (Clip) los registra el portal, no la caja.
  const active = methods.filter((m) => m.active && m.kind !== 'en_linea');
  const remaining = round2(num(order.total) - num(order.paid_amount));
  const newLine = (methodId: string, amount: number): Line => ({
    key: nextKey++, methodId, amount: amount > 0 ? amount.toFixed(2) : '', tip: '', received: '', reference: '',
  });
  const [lines, setLines] = useState<Line[]>(() => [newLine(active[0]?.id || '', remaining)]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ order: Order; change: number } | null>(null);

  const kindOf = (id: string) => active.find((m) => m.id === id)?.kind;
  const applied = round2(lines.reduce((s, l) => s + num(l.amount), 0));
  const tips = round2(lines.reduce((s, l) => s + num(l.tip), 0));
  const change = round2(lines.reduce((s, l) => (kindOf(l.methodId) === 'efectivo' && l.received
    ? s + Math.max(0, num(l.received) - num(l.amount) - num(l.tip)) : s), 0));
  const pending = round2(remaining - applied);
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const problems: string[] = [];
  if (applied > remaining + 0.001) problems.push('Los pagos exceden el saldo');
  for (const l of lines) {
    if (!l.methodId) problems.push('Elige el método de pago');
    if (kindOf(l.methodId) === 'efectivo' && l.received && num(l.received) < num(l.amount) + num(l.tip)) {
      problems.push('El efectivo recibido no cubre el pago');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problems.length) return;
    setSaving(true);
    setError('');
    try {
      const r = await api<{ order: Order; change: number }>(`/pos/orders/${order.id}/payments`, {
        method: 'POST',
        body: {
          cash_session_id: sessionId,
          payments: lines.filter((l) => num(l.amount) + num(l.tip) > 0).map((l) => ({
            payment_method_id: l.methodId,
            amount: num(l.amount),
            tip: num(l.tip),
            received: kindOf(l.methodId) === 'efectivo' && l.received ? num(l.received) : undefined,
            reference: l.reference || null,
          })),
        },
      });
      if (r.order.status === 'pagada') {
        setDone({ order: r.order, change: r.change });
        // En la app con impresora de tickets: sale el ticket solo y, si hubo
        // efectivo, se abre el cajon.
        const cash = lines.some((l) => kindOf(l.methodId) === 'efectivo' && num(l.amount) > 0);
        nativeInfo().then((info) => {
          if (info?.printers.ticket) onPrint(r.order, r.change, { openDrawer: cash });
          else if (cash && info?.drawer) void getNative()?.openDrawer();
        });
      }
      else onPaid(r.order, r.change);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <Modal title="Cuenta pagada" onClose={() => onPaid(done.order, done.change)}>
        <div className="space-y-5 text-center">
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-400" />
          <div>
            <p className="text-sm text-gray-400">Cambio a entregar</p>
            <p className={`text-5xl font-bold ${done.change > 0 ? 'text-amber-300' : 'text-white'}`}>{formatMXN(done.change)}</p>
          </div>
          <div className="flex justify-center gap-2">
            <Button variant="secondary" onClick={() => onPrint(done.order, done.change)}><Printer className="h-4 w-4" /> Imprimir ticket</Button>
            <Button onClick={() => onPaid(done.order, done.change)}>Listo</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Cobrar folio ${order.folio}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-gray-800 p-3"><p className="text-xs text-gray-400">Total</p><p className="text-lg font-semibold">{formatMXN(order.total)}</p></div>
          <div className="rounded-xl bg-gray-800 p-3"><p className="text-xs text-gray-400">Pagado</p><p className="text-lg font-semibold">{formatMXN(order.paid_amount)}</p></div>
          <div className="rounded-xl bg-brand/15 p-3 ring-1 ring-brand/40"><p className="text-xs text-gray-300">Por cobrar</p><p className="text-lg font-bold text-white">{formatMXN(remaining)}</p></div>
        </div>

        {lines.map((l) => {
          const isCash = kindOf(l.methodId) === 'efectivo';
          const lineChange = isCash && l.received ? num(l.received) - num(l.amount) - num(l.tip) : 0;
          return (
            <div key={l.key} className="space-y-3 rounded-xl border border-gray-800 p-3">
              <div className="flex flex-wrap gap-2">
                {active.map((m) => (
                  <button key={m.id} type="button" onClick={() => update(l.key, { methodId: m.id, received: '' })}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold ${l.methodId === m.id ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-300'}`}>
                    {m.name}
                  </button>
                ))}
                {lines.length > 1 && (
                  <button type="button" className="ml-auto rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-red-300"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Quitar pago"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block"><span className="label">Monto a la cuenta</span>
                  <input className="input text-lg font-semibold" type="number" inputMode="decimal" min="0" step="0.01" value={l.amount}
                    onChange={(e) => update(l.key, { amount: e.target.value })} /></label>
                <label className="block"><span className="label">Propina</span>
                  <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={l.tip} placeholder="0.00"
                    onChange={(e) => update(l.key, { tip: e.target.value })} />
                  <span className="mt-1 flex gap-1">
                    {[10, 15].map((p) => (
                      <button key={p} type="button" className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-700"
                        onClick={() => update(l.key, { tip: round2((num(order.total) * p) / 100).toFixed(2) })}>{p}%</button>
                    ))}
                  </span>
                </label>
                {isCash ? (
                  <label className="block"><span className="label">Recibido</span>
                    <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={l.received} placeholder="Exacto"
                      onChange={(e) => update(l.key, { received: e.target.value })} />
                  </label>
                ) : (
                  <label className="block"><span className="label">Referencia</span>
                    <input className="input" value={l.reference} maxLength={100} placeholder="Opcional"
                      onChange={(e) => update(l.key, { reference: e.target.value })} />
                  </label>
                )}
              </div>
              {isCash && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
                    onClick={() => update(l.key, { received: (num(l.amount) + num(l.tip)).toFixed(2) })}>Exacto</button>
                  {QUICK_CASH.filter((q) => q >= num(l.amount) + num(l.tip)).slice(0, 4).map((q) => (
                    <button key={q} type="button" className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
                      onClick={() => update(l.key, { received: String(q) })}>{formatMXN(q)}</button>
                  ))}
                  {lineChange > 0 && <span className="ml-auto text-sm text-amber-300">Cambio {formatMXN(lineChange)}</span>}
                </div>
              )}
            </div>
          );
        })}

        {pending > 0 && (
          <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine(active.find((m) => m.kind !== 'efectivo')?.id || active[0]?.id || '', pending)])}>
            <Plus className="h-4 w-4" /> Dividir: agregar otro pago ({formatMXN(pending)})
          </Button>
        )}

        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-gray-800 pt-4">
          <div className="text-sm text-gray-400">
            {pending > 0 ? <>Quedará pendiente <b className="text-white">{formatMXN(pending)}</b></> : <>Cubre el total</>}
            {tips > 0 && <> · Propina {formatMXN(tips)}</>}
            {change > 0 && <div className="text-2xl font-bold text-amber-300">Cambio {formatMXN(change)}</div>}
            {problems[0] && <div className="text-amber-300">{problems[0]}</div>}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={saving} disabled={problems.length > 0 || (applied <= 0 && remaining > 0)}>
              {pending > 0 ? 'Registrar pago parcial' : 'Cobrar'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
