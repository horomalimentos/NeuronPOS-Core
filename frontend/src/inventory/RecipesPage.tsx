import { Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { fmtQty, unitOptions } from './lib';
import type { InvProduct, RecipeDetail, RecipeLine } from './types';

interface MenuRow { id: string; name: string; price: string; category: string; ingredients: number; cost: number; cost_pct: number | null }
interface EditLine { product_id: string; quantity: string; unit: string }

const pctStyle = (p: number | null) => (p === null ? 'text-gray-500' : p > 40 ? 'text-red-300' : p > 32 ? 'text-amber-300' : 'text-emerald-300');

/**
 * Recetas: que insumos gasta cada producto del menu (y cada modificador) al
 * venderse. Con eso se descuenta el inventario al cobrar y se calcula el
 * costo y su porcentaje sobre el precio.
 */
export default function RecipesPage() {
  const [items, setItems] = useState<MenuRow[] | null>(null);
  const [products, setProducts] = useState<InvProduct[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<MenuRow | null>(null);

  const load = useCallback(() => {
    Promise.all([api<{ items: MenuRow[] }>('/inventory/recipes'), api<{ products: InvProduct[] }>('/inventory/products')])
      .then(([r, p]) => { setItems(r.items); setProducts(p.products); })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const out = new Map<string, MenuRow[]>();
    for (const i of items || []) {
      if (q && !i.name.toLowerCase().includes(q.toLowerCase())) continue;
      out.set(i.category, [...(out.get(i.category) || []), i]);
    }
    return [...out];
  }, [items, q]);

  if (error) return <Alert>{error}</Alert>;
  if (!items) return <Spinner />;
  const withRecipe = items.filter((i) => i.ingredients > 0).length;

  return (
    <>
      <PageHeader title="Recetas" subtitle={`${withRecipe} de ${items.length} productos del menú tienen receta.`} />
      {products.length === 0 && <div className="mb-4"><Alert kind="warning">Primero da de alta tus insumos en la pestaña Insumos.</Alert></div>}
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input className="input pl-9" placeholder="Buscar producto" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar producto" />
      </label>
      {items.length === 0 && <div className="card p-6 text-sm text-gray-400">Tu menú todavía no tiene productos.</div>}
      <div className="space-y-4">
        {groups.map(([cat, rows]) => (
          <section key={cat} className="card overflow-hidden">
            <h2 className="border-b border-gray-800 px-4 py-2 text-sm font-medium text-gray-400">{cat}</h2>
            <div className="divide-y divide-gray-800/70">
              {rows.map((i) => (
                <button key={i.id} type="button" onClick={() => setOpen(i)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-gray-900/60">
                  <span>
                    <span className="text-white">{i.name}</span>
                    <span className="block text-xs text-gray-500">{i.ingredients ? `${i.ingredients} insumos` : 'Sin receta'}</span>
                  </span>
                  <span className="text-right text-sm tabular-nums">
                    <span className="text-gray-300">{formatMXN(i.cost)} de {formatMXN(i.price)}</span>
                    <span className={`block text-xs ${pctStyle(i.ingredients ? i.cost_pct : null)}`}>{i.ingredients && i.cost_pct !== null ? `${i.cost_pct}% costo` : '—'}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {open && <RecipeModal item={open} products={products} onClose={() => setOpen(null)} onSaved={load} />}
    </>
  );
}

const toEdit = (ls: RecipeLine[]): EditLine[] => ls.map((l) => ({ product_id: l.product_id, quantity: String(Number(l.quantity)), unit: l.base_unit }));
const toBody = (ls: EditLine[]) => ls.filter((l) => l.product_id && Number(l.quantity) > 0)
  .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit: l.unit }));

function RecipeModal({ item, products, onClose, onSaved }: { item: MenuRow; products: InvProduct[]; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<RecipeDetail | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [modEdit, setModEdit] = useState<{ id: string; name: string; specific: boolean; lines: EditLine[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const apply = (d: RecipeDetail) => { setData(d); setLines(toEdit(d.lines)); };
  useEffect(() => {
    api<RecipeDetail>(`/inventory/recipes/${item.id}`).then(apply).catch((e) => setError(errorMessage(e)));
  }, [item.id]);

  const saveMain = async () => {
    setBusy(true);
    setError('');
    try {
      apply(await api<RecipeDetail>(`/inventory/recipes/${item.id}`, { method: 'PUT', body: { items: toBody(lines) } }));
      setSaved(true);
      onSaved();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };

  const saveMod = async () => {
    if (!modEdit) return;
    setBusy(true);
    setError('');
    try {
      const body = { items: toBody(modEdit.lines), menu_item_id: modEdit.specific ? item.id : undefined };
      const r = await api<RecipeDetail | { ok: true }>(`/inventory/modifier-recipes/${modEdit.id}`, { method: 'PUT', body });
      if ('item' in r) apply(r);
      else apply(await api<RecipeDetail>(`/inventory/recipes/${item.id}`));
      setModEdit(null);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };

  if (!data) return <Modal title={item.name} onClose={onClose}>{error ? <Alert>{error}</Alert> : <Spinner />}</Modal>;
  const liveCost = lines.reduce((a, l) => {
    const p = products.find((x) => x.id === l.product_id);
    const f = p ? unitOptions(p).find((u) => u.name === l.unit)?.factor ?? 1 : 1;
    return a + Number(l.quantity || 0) * f * Number(p?.unit_cost || 0);
  }, 0);
  const price = Number(data.item.price);

  return (
    <Modal title={item.name} onClose={onClose} wide>
      <div className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-gray-400">Precio {formatMXN(price)}</span>
          <span className="text-sm">
            Costo <b className="tabular-nums text-white">{formatMXN(liveCost)}</b>
            {price > 0 && <span className={`ml-2 tabular-nums ${pctStyle((liveCost / price) * 100)}`}>{((liveCost / price) * 100).toFixed(1)}%</span>}
          </span>
        </div>
        <LinesEditor lines={lines} products={products} onChange={(l) => { setLines(l); setSaved(false); }} />
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-emerald-300">Guardada</span>}
          <Button onClick={saveMain} loading={busy && !modEdit}>Guardar receta</Button>
        </div>

        {data.modifiers.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">Modificadores</h3>
            <p className="mb-2 text-xs text-gray-500">
              Lo que gasta cada modificador. La receta general aplica a todos los productos; la de este producto la reemplaza solo aquí.
            </p>
            <div className="divide-y divide-gray-800/70 rounded-xl border border-gray-800">
              {data.modifiers.map((m) => {
                const editing = modEdit?.id === m.id;
                const shown = m.specific.length ? m.specific : m.general;
                return (
                  <div key={m.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-white">{m.name} <span className="text-xs text-gray-500">{m.group_name}</span></span>
                      <span className="flex items-center gap-3 text-xs">
                        <span className="tabular-nums text-gray-400">{formatMXN(m.cost)}</span>
                        {!editing && (
                          <button type="button" className="text-brand hover:underline"
                            onClick={() => setModEdit({ id: m.id, name: m.name, specific: m.specific.length > 0, lines: toEdit(m.specific.length ? m.specific : m.general) })}>
                            Editar
                          </button>
                        )}
                      </span>
                    </div>
                    {!editing && (
                      <p className="text-xs text-gray-500">
                        {shown.length
                          ? `${m.specific.length ? 'Solo aquí' : 'General'}: ${shown.map((l) => `${fmtQty(l.quantity)} ${l.base_unit} ${l.name}`).join(', ')}`
                          : 'Sin receta'}
                      </p>
                    )}
                    {editing && modEdit && (
                      <div className="mt-2 space-y-2">
                        <div className="flex gap-2">
                          {([[false, 'General'], [true, 'Solo para este producto']] as const).map(([s, label]) => (
                            <button key={label} type="button"
                              onClick={() => setModEdit({ ...modEdit, specific: s, lines: toEdit(s ? m.specific : m.general) })}
                              className={`rounded-lg border px-2.5 py-1 text-xs ${modEdit.specific === s ? 'border-brand bg-brand/10 text-white' : 'border-gray-700 text-gray-400'}`}>
                              {label}
                            </button>
                          ))}
                        </div>
                        <LinesEditor lines={modEdit.lines} products={products} onChange={(l) => setModEdit({ ...modEdit, lines: l })} />
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" onClick={() => setModEdit(null)}>Cancelar</Button>
                          <Button onClick={saveMod} loading={busy}>Guardar</Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}

function LinesEditor({ lines, products, onChange }: { lines: EditLine[]; products: InvProduct[]; onChange: (l: EditLine[]) => void }) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const update = (i: number, patch: Partial<EditLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {lines.map((l, i) => {
        const p = byId.get(l.product_id);
        return (
          <div key={`${l.product_id}-${i}`} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[8rem] flex-1 text-sm text-gray-200">{p?.name || 'Insumo dado de baja'}</span>
            <input className="input w-24 text-right" type="number" min="0" step="any" value={l.quantity} aria-label={`Cantidad de ${p?.name || 'insumo'}`}
              onChange={(e) => update(i, { quantity: e.target.value })} />
            <select className="input w-auto" value={l.unit} aria-label="Unidad" onChange={(e) => update(i, { unit: e.target.value })}>
              {p ? unitOptions(p).map((u) => <option key={u.name}>{u.name}</option>) : <option>{l.unit}</option>}
            </select>
            <button type="button" className="p-1 text-gray-500 hover:text-red-300" aria-label="Quitar"
              onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
          </div>
        );
      })}
      <select className="input" value="" aria-label="Agregar insumo"
        onChange={(e) => {
          const p = byId.get(e.target.value);
          if (p) onChange([...lines, { product_id: p.id, quantity: '', unit: p.base_unit }]);
        }}>
        <option value="">+ Agregar insumo…</option>
        {products.filter((p) => !lines.some((l) => l.product_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.base_unit})</option>)}
      </select>
    </div>
  );
}
