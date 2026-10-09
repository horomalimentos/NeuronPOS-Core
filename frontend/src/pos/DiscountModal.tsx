import { DollarSign, KeyRound, Percent } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { num } from './lib';
import type { Order, OrderItem } from './types';

/**
 * Descuento a la cuenta o a un articulo (porcentaje o cantidad). El backend
 * decide si el rol puede darlo: admin/gerente sin limite, cajero hasta el %
 * configurado; arriba de eso pide el PIN del gerente (cambia cada 10 min).
 */
export default function DiscountModal({ order, item, maxPct, onClose, onSaved }: {
  order: Order; item?: OrderItem; maxPct: number | null; onClose: () => void; onSaved: (o: Order) => void;
}) {
  const current = item || order;
  const [type, setType] = useState<'percent' | 'amount'>(current.discount_type || 'percent');
  const [value, setValue] = useState(current.discount_value ? String(num(current.discount_value)) : '');
  const [reason, setReason] = useState(current.discount_reason || '');
  const [pin, setPin] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const path = item ? `/pos/orders/${order.id}/items/${item.id}/discount` : `/pos/orders/${order.id}/discount`;

  // Base: el importe del articulo, o la cuenta despues de promociones y descuentos por articulo.
  const base = item ? num(item.line_total) : Math.max(0, num(order.subtotal) - num(order.promo_discount) - num(order.item_discount));
  const preview = type === 'percent' ? Math.min(base, (base * Math.min(100, num(value))) / 100) : Math.min(base, num(value));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await api<{ order: Order }>(path, { method: 'PUT', body: { type, value: num(value), reason: reason || null, pin: pin || undefined } });
      onSaved(r.order);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'DISCOUNT_NOT_ALLOWED' || err.code === 'INVALID_PIN')) setNeedPin(true);
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      const r = await api<{ order: Order }>(path, { method: 'DELETE' });
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
    <Modal title={item ? `Descuento a ${item.quantity} × ${item.name}` : 'Descuento a la cuenta'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-2">{tab('percent', 'Porcentaje', Percent)}{tab('amount', 'Cantidad', DollarSign)}</div>
        <Field label={type === 'percent' ? 'Porcentaje (%)' : 'Cantidad ($)'}
          hint={maxPct !== null ? (maxPct > 0 ? `Tu rol puede descontar hasta ${maxPct}% sin autorización.` : 'Para descontar necesitas el PIN del gerente.') : undefined}>
          <input className="input text-lg font-semibold" type="number" inputMode="decimal" min="0" step="0.01" required autoFocus
            value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Motivo"><input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej. cortesía, cliente frecuente…" /></Field>
        {needPin && (
          <Field label="PIN del gerente" hint="El gerente lo ve en su pantalla (botón de llave) y cambia cada 10 minutos.">
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input className="input pl-9 tracking-[0.4em]" inputMode="numeric" maxLength={6} autoFocus value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
            </div>
          </Field>
        )}
        <p className="text-sm text-gray-400">Descuento: <b className="text-white">{formatMXN(preview)}</b> de {formatMXN(base)}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {current.discount_type && <Button type="button" variant="ghost" onClick={remove} disabled={saving}>Quitar descuento</Button>}
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Aplicar</Button>
        </div>
      </form>
    </Modal>
  );
}
