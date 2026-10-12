import { useState } from 'react';
import { Button, Modal } from '../components/ui';
import { formatMoney } from './lib';

/** Billetes y monedas de cada moneda (como el contador de Horom). */
const DENOMINATIONS: Record<'MXN' | 'USD', { bills: number[]; coins: number[] }> = {
  MXN: { bills: [1000, 500, 200, 100, 50, 20], coins: [20, 10, 5, 2, 1, 0.5] },
  USD: { bills: [100, 50, 20, 10, 5, 2, 1], coins: [] },
};

export type DenominationCount = Record<string, number>;

/**
 * Contar el efectivo por billetes y monedas. Regresa el total y el detalle
 * (que se guarda con el corte para consulta).
 */
export default function DenominationModal({ currency, initial, onClose, onDone }: {
  currency: 'MXN' | 'USD'; initial?: DenominationCount; onClose: () => void;
  onDone: (total: number, detail: DenominationCount) => void;
}) {
  const [qty, setQty] = useState<DenominationCount>(initial || {});
  const { bills, coins } = DENOMINATIONS[currency];
  // Las monedas de 20 pesos comparten valor con el billete: se guardan con prefijo.
  const key = (v: number, coin: boolean) => (coin ? `m${v}` : String(v));
  const total = Math.round([...bills.map((v) => [v, key(v, false)] as const), ...coins.map((v) => [v, key(v, true)] as const)]
    .reduce((s, [v, k]) => s + v * (qty[k] || 0), 0) * 100) / 100;

  const row = (v: number, coin: boolean) => {
    const k = key(v, coin);
    return (
      <label key={k} className="flex items-center gap-2 text-sm">
        <span className="w-20 text-right text-gray-300">{formatMoney(v, currency)}</span>
        <span className="text-gray-500">×</span>
        <input className="input w-20 py-1.5 text-right" type="number" inputMode="numeric" min="0" step="1" value={qty[k] || ''}
          onChange={(e) => setQty({ ...qty, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} aria-label={`${coin ? 'Monedas' : 'Billetes'} de ${v}`} />
        <span className="ml-auto text-gray-400">{formatMoney(v * (qty[k] || 0), currency)}</span>
      </label>
    );
  };

  return (
    <Modal title={`Contar efectivo (${currency === 'USD' ? 'dólares' : 'pesos'})`} onClose={onClose}>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2"><p className="text-xs uppercase tracking-wider text-gray-500">Billetes</p>{bills.map((v) => row(v, false))}</div>
        {coins.length > 0 && <div className="space-y-2"><p className="text-xs uppercase tracking-wider text-gray-500">Monedas</p>{coins.map((v) => row(v, true))}</div>}
      </div>
      <div className="mt-5 flex items-center justify-between border-t border-gray-800 pt-4">
        <p className="text-lg text-gray-300">Total <b className="text-white">{formatMoney(total, currency)}</b></p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onDone(total, Object.fromEntries(Object.entries(qty).filter(([, n]) => n > 0)))}>Usar este total</Button>
        </div>
      </div>
    </Modal>
  );
}
