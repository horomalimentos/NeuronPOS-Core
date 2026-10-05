import { DollarSign, Percent } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { num } from './lib';
import type { Order } from './types';

/**
 * Descuento a la cuenta (porcentaje o cantidad). El backend decide si el rol
 * puede darlo: admin/gerente sin limite, cajero hasta el % configurado.
 */
export default function DiscountModal({ order, maxPct, onClose, onSaved }: {
  order: Order; maxPct: number | null; onClose: () => void; onSaved: (o: Order) => void;
}) {
  const [type, setType] = useState<'percent' | 'amount'>(order.discount_type || 'percent');
  const [value, setValue] = useState(order.discount_value ? String(num(order.discount_value)) : '');
  const [reason, setReason] = useState(order.discount_reason || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const preview = type === 'percent'
    ? Math.min(num(order.subtotal), (num(order.subtotal) * Math.min(100, num(value))) / 100)
    : Math.min(num(order.subtotal), num(value));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await api<{ order: Order }>(`/pos/orders/${order.id}/discount`, { method: 'PUT', body: { type, value: num(value), reason: reason || null } });
      onSaved(r.order);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      const r = await api<{ order: Order }>(`/pos/orders/${order.id}/discount`, { method: 'DELETE' });
      onSaved(r.order);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const tab = (t: 'percent' | 'amount', label: string, Icon: typeof Percent) => (
    <button type="button" onClick={() => setType(t)}
      className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold
        ${type === t ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-300'}`}>
      <Icon className="h-4 w-4" /> {label}
    </button>
  );

  return (
    <Modal title="Descuento a la cuenta" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-2">{tab('percent', 'Porcentaje', Percent)}{tab('amount', 'Cantidad', DollarSign)}</div>
        <Field label={type === 'percent' ? 'Porcentaje (%)' : 'Cantidad ($)'}
          hint={maxPct !== null ? (maxPct > 0 ? `Tu rol puede descontar hasta ${maxPct}% de la cuenta.` : 'Tu rol no puede aplicar descuentos.') : undefined}>
          <input className="input text-lg font-semibold" type="number" inputMode="decimal" min="0" step="0.01" required autoFocus
            value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Motivo"><input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej. cortesía, cliente frecuente…" /></Field>
        <p className="text-sm text-gray-400">Descuento: <b className="text-white">{formatMXN(preview)}</b> de {formatMXN(order.subtotal)}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {order.discount_type && <Button type="button" variant="ghost" onClick={remove} disabled={saving}>Quitar descuento</Button>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Aplicar</Button>
        </div>
      </form>
    </Modal>
  );
}
