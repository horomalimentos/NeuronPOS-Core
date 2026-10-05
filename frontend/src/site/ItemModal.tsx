import { Check, Minus, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { formatMXN } from '../lib/format';
import type { CartLine } from './cart';
import type { PortalItem, PortalModifier, PortalModifierGroup } from './types';

const num = (v: unknown) => Number(v || 0);

/**
 * Detalle de un producto: modificadores (respeta minimo y maximo por grupo),
 * cantidad y notas. El servidor vuelve a validar todo al hacer el pedido.
 */
export default function ItemModal({ item, groups, onClose, onAdd }: {
  item: PortalItem;
  groups: PortalModifierGroup[];
  onClose: () => void;
  onAdd: (line: Omit<CartLine, 'key'>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  const toggle = (g: PortalModifierGroup, m: PortalModifier) => {
    setSelected((prev) => {
      const cur = prev[g.id] || [];
      if (cur.includes(m.id)) return { ...prev, [g.id]: cur.filter((x) => x !== m.id) };
      if (g.max_selections === 1) return { ...prev, [g.id]: [m.id] };
      if (g.max_selections !== null && cur.length >= g.max_selections) return prev;
      return { ...prev, [g.id]: [...cur, m.id] };
    });
  };

  const chosen = groups.flatMap((g) => g.modifiers.filter((m) => (selected[g.id] || []).includes(m.id)));
  const missing = groups.filter((g) => (selected[g.id] || []).length < g.min_selections);
  const unit = num(item.price) + chosen.reduce((s, m) => s + num(m.price_delta), 0);

  const add = () => onAdd({
    item_id: item.id,
    name: item.name,
    image_url: item.image_url,
    unit_price: Math.round(unit * 100) / 100,
    quantity,
    modifier_ids: chosen.map((m) => m.id),
    modifier_names: chosen.map((m) => m.name),
    notes: notes.trim(),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={item.name}>
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
        <div className="relative">
          {item.image_url && <img src={item.image_url} alt="" className="h-48 w-full object-cover" />}
          <button onClick={onClose} className="absolute right-3 top-3 rounded-full bg-white/90 p-2 text-gray-700 shadow hover:bg-white" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-4 pt-5">
          <h2 className="pr-10 text-xl font-bold text-gray-900">{item.name}</h2>
          {item.description && <p className="mt-1 text-sm text-gray-500">{item.description}</p>}
          <p className="mt-2 font-semibold text-brand">{formatMXN(item.price)}</p>

          {groups.map((g) => {
            const count = (selected[g.id] || []).length;
            const rule = g.min_selections > 0
              ? (g.max_selections === g.min_selections ? `Elige ${g.min_selections}` : `Mínimo ${g.min_selections}${g.max_selections ? `, máximo ${g.max_selections}` : ''}`)
              : (g.max_selections ? `Opcional · hasta ${g.max_selections}` : 'Opcional');
            return (
              <section key={g.id} className="mt-5">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-gray-900">{g.name}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${count < g.min_selections ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-500'}`}>{rule}</span>
                </div>
                <div className="space-y-2">
                  {g.modifiers.map((m) => {
                    const on = (selected[g.id] || []).includes(m.id);
                    return (
                      <button key={m.id} type="button" onClick={() => toggle(g, m)} aria-pressed={on}
                        className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition
                          ${on ? 'border-brand bg-brand/5' : 'border-gray-200 hover:border-gray-300'}`}>
                        <span className="flex items-center gap-3">
                          <span className={`flex h-5 w-5 items-center justify-center ${g.max_selections === 1 ? 'rounded-full' : 'rounded-md'} border-2 ${on ? 'border-brand bg-brand text-brand-contrast' : 'border-gray-300'}`}>
                            {on && <Check className="h-3 w-3" />}
                          </span>
                          {m.name}
                        </span>
                        {num(m.price_delta) !== 0 && <span className="text-gray-500">{num(m.price_delta) > 0 ? '+' : ''}{formatMXN(m.price_delta)}</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <label className="mt-5 block">
            <span className="label-light">Indicaciones (opcional)</span>
            <input className="input-light" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. sin cebolla" />
          </label>
        </div>
        <div className="flex items-center gap-3 border-t border-gray-200 p-4">
          <div className="flex items-center gap-1 rounded-full border border-gray-300 p-1">
            <button type="button" className="rounded-full p-2 hover:bg-gray-100" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Menos"><Minus className="h-4 w-4" /></button>
            <span className="w-7 text-center font-semibold">{quantity}</span>
            <button type="button" className="rounded-full p-2 hover:bg-gray-100" onClick={() => setQuantity((q) => Math.min(99, q + 1))} aria-label="Más"><Plus className="h-4 w-4" /></button>
          </div>
          <button className="btn-brand flex-1 py-3" disabled={missing.length > 0} onClick={add}>
            {missing.length > 0 ? `Elige ${missing[0].name.toLowerCase()}` : `Agregar · ${formatMXN(unit * quantity)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
