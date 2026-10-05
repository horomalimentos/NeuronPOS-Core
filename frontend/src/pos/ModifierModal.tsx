import { Check, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button, Modal } from '../components/ui';
import { formatMXN } from '../lib/format';
import { num } from './lib';
import type { MenuItem, Modifier, ModifierGroup } from './types';

export interface CartSelection {
  item: MenuItem;
  quantity: number;
  modifiers: (Modifier & { group_name: string })[];
  notes: string;
}

/**
 * Elegir modificadores de un producto (respeta minimo y maximo por grupo),
 * cantidad y notas. Basado en ModifierSelectionModal de NeuronPOS.
 */
export default function ModifierModal({ item, groups, onClose, onAdd }: {
  item: MenuItem; groups: ModifierGroup[]; onClose: () => void; onAdd: (sel: CartSelection) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  const toggle = (g: ModifierGroup, m: Modifier) => {
    setSelected((prev) => {
      const cur = prev[g.id] || [];
      if (cur.includes(m.id)) return { ...prev, [g.id]: cur.filter((x) => x !== m.id) };
      // Un solo valor: reemplaza. Varios: respeta el maximo.
      if (g.max_selections === 1) return { ...prev, [g.id]: [m.id] };
      if (g.max_selections !== null && cur.length >= g.max_selections) return prev;
      return { ...prev, [g.id]: [...cur, m.id] };
    });
  };

  const chosen = groups.flatMap((g) => g.modifiers
    .filter((m) => (selected[g.id] || []).includes(m.id))
    .map((m) => ({ ...m, group_name: g.name })));
  const missing = groups.filter((g) => (selected[g.id] || []).length < g.min_selections);
  const unit = num(item.price) + chosen.reduce((s, m) => s + num(m.price_delta), 0);

  return (
    <Modal title={item.name} onClose={onClose} wide>
      <div className="space-y-5">
        {groups.map((g) => {
          const count = (selected[g.id] || []).length;
          const rule = g.min_selections > 0
            ? (g.max_selections === g.min_selections ? `Elige ${g.min_selections}` : `Mínimo ${g.min_selections}${g.max_selections ? `, máximo ${g.max_selections}` : ''}`)
            : (g.max_selections ? `Opcional, hasta ${g.max_selections}` : 'Opcional');
          return (
            <section key={g.id}>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="font-semibold text-white">{g.name}</h3>
                <span className={`text-xs ${count < g.min_selections ? 'text-amber-300' : 'text-gray-500'}`}>{rule}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {g.modifiers.map((m) => {
                  const on = (selected[g.id] || []).includes(m.id);
                  return (
                    <button key={m.id} type="button" onClick={() => toggle(g, m)}
                      className={`flex min-h-[3.25rem] items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm transition
                        ${on ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-200 hover:border-gray-500'}`}>
                      <span>{m.name}{num(m.price_delta) !== 0 && <span className="block text-xs text-gray-400">{num(m.price_delta) > 0 ? '+' : ''}{formatMXN(m.price_delta)}</span>}</span>
                      {on && <Check className="h-4 w-4 flex-shrink-0 text-brand" />}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
        <label className="block">
          <span className="label">Notas para cocina</span>
          <input className="input" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. sin chile, bien cocido…" />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 pt-4">
          <div className="flex items-center gap-2">
            <button type="button" className="rounded-lg bg-gray-800 p-2.5 text-gray-200 hover:bg-gray-700" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Menos"><Minus className="h-4 w-4" /></button>
            <span className="w-8 text-center text-lg font-semibold">{quantity}</span>
            <button type="button" className="rounded-lg bg-gray-800 p-2.5 text-gray-200 hover:bg-gray-700" onClick={() => setQuantity((q) => Math.min(999, q + 1))} aria-label="Más"><Plus className="h-4 w-4" /></button>
          </div>
          <Button disabled={missing.length > 0} onClick={() => onAdd({ item, quantity, modifiers: chosen, notes: notes.trim() })}>
            Agregar · {formatMXN(unit * quantity)}
          </Button>
        </div>
        {missing.length > 0 && <p className="text-right text-xs text-amber-300">Falta elegir: {missing.map((g) => g.name).join(', ')}</p>}
      </div>
    </Modal>
  );
}
