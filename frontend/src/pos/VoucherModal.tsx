import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Order } from './types';

/** Aplicar un vale o codigo promocional a la orden. */
export default function VoucherModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
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
