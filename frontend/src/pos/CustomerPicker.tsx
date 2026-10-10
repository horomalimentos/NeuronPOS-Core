import { Award, Plus, Search, UserRound, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { NewCustomerModal, type CustomerRow } from '../restaurant/CustomersPage';
import type { Order } from './types';

/** Buscar o registrar al cliente de la orden (por telefono o nombre). */
export function CustomerPicker({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = window.setTimeout(() => {
      api<{ customers: CustomerRow[] }>(`/customers?q=${encodeURIComponent(q.trim())}`).then((r) => setResults(r.customers)).catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  async function pick(id: string | null) {
    setError('');
    try {
      onSaved((await api<{ order: Order }>(`/pos/orders/${order.id}/customer`, { method: 'PUT', body: { customer_id: id } })).order);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (creating) return <NewCustomerModal initial={q} onClose={() => setCreating(false)} onSaved={(c) => pick(c.id)} />;
  return (
    <Modal title="Cliente de la orden" onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input className="input pl-9" autoFocus placeholder="Teléfono o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="max-h-72 divide-y divide-gray-800 overflow-y-auto">
          {results.map((c) => (
            <li key={c.id}>
              <button onClick={() => pick(c.id)} className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-gray-800/50">
                <UserRound className="h-4 w-4 text-gray-500" />
                <span className="flex-1 text-sm text-white">{c.name}<span className="block text-xs text-gray-500">{c.phone}</span></span>
                {c.points > 0 && <span className="flex items-center gap-1 text-xs font-semibold text-amber-200"><Award className="h-3.5 w-3.5" />{c.points}</span>}
              </button>
            </li>
          ))}
          {q.trim().length >= 2 && results.length === 0 && <li className="py-2 text-sm text-gray-500">Sin resultados.</li>}
        </ul>
        <div className="flex flex-wrap justify-between gap-2 border-t border-gray-800 pt-3">
          {order.customer_id ? <Button variant="ghost" onClick={() => pick(null)}><X className="h-4 w-4" /> Quitar cliente</Button> : <span />}
          <Button variant="secondary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo cliente</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Canjear puntos del cliente como descuento (el servidor revisa saldo, minimo y maximo). */
export function RedeemPoints({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const [settings, setSettings] = useState<{ program_name: string; peso_per_point: number; min_redeem: number } | null>(null);
  const [points, setPoints] = useState(order.loyalty_points_redeemed ? String(order.loyalty_points_redeemed) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ settings: { program_name: string; peso_per_point: number; min_redeem: number } }>('/customers/program').then((r) => setSettings(r.settings)).catch(() => undefined);
  }, []);
  const balance = Number(order.customer_points || 0);
  async function save(value: number) {
    setSaving(true);
    setError('');
    try {
      onSaved((await api<{ order: Order }>(`/pos/orders/${order.id}/loyalty`, { method: 'PUT', body: { points: value } })).order);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={settings?.program_name || 'Puntos'} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void save(Math.trunc(Number(points) || 0)); }} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-300">{order.customer_name} tiene <b className="text-amber-200">{balance} puntos</b>{settings ? ` (${formatMXN(balance * settings.peso_per_point)})` : ''}.</p>
        <Field label="Puntos a canjear" hint={settings ? `Mínimo ${settings.min_redeem} puntos. Cada punto vale ${formatMXN(settings.peso_per_point)}.` : undefined}>
          <input className="input text-lg font-semibold" type="number" min="0" max={balance} step="1" autoFocus value={points} onChange={(e) => setPoints(e.target.value)} />
        </Field>
        {settings && Number(points) > 0 && <p className="text-sm text-gray-400">Descuento: <b className="text-white">{formatMXN(Number(points) * settings.peso_per_point)}</b></p>}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {order.loyalty_points_redeemed ? <Button type="button" variant="ghost" onClick={() => save(0)} disabled={saving}>Quitar canje</Button> : null}
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Canjear</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Aplicar un vale o codigo promocional a la orden. */
export function VoucherModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const [code, setCode] = useState(order.voucher_code || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(value: string | null) {
    setSaving(true);
    setError('');
    try {
      onSaved((await api<{ order: Order }>(`/pos/orders/${order.id}/voucher`, { method: 'PUT', body: { code: value } })).order);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Vale o código promocional" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void save(code.trim() || null); }} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Código"><input className="input text-lg font-semibold uppercase tracking-wider" autoFocus maxLength={30} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <div className="flex flex-wrap justify-end gap-2">
          {order.voucher_id && <Button type="button" variant="ghost" onClick={() => save(null)} disabled={saving}>Quitar vale</Button>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving} disabled={!code.trim()}>Aplicar</Button>
        </div>
      </form>
    </Modal>
  );
}
