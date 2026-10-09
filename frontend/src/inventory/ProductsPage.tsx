import { Camera, FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { WEEKDAYS, fmtQty } from './lib';
import type { InvArea, InvProduct, InvSupplier, InvUnit } from './types';

/** Catalogo de insumos: unidad base, unidades de compra, area, proveedor, minimos y dias de conteo. */
export default function ProductsPage() {
  const [products, setProducts] = useState<InvProduct[] | null>(null);
  const [areas, setAreas] = useState<InvArea[]>([]);
  const [suppliers, setSuppliers] = useState<InvSupplier[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<InvProduct | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api<{ products: InvProduct[] }>(`/inventory/products${showInactive ? '?all=1' : ''}`),
      api<{ areas: InvArea[] }>('/inventory/areas'),
      api<{ suppliers: InvSupplier[] }>('/inventory/suppliers'),
    ]).then(([p, a, s]) => { setProducts(p.products); setAreas(a.areas); setSuppliers(s.suppliers); })
      .catch((e) => setError(errorMessage(e)));
  }, [showInactive]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!products) return <Spinner />;

  return (
    <>
      <PageHeader
        title="Insumos"
        subtitle="Lo que compras y cuentas: carne, verduras, desechables… con su unidad base y la de compra."
        actions={<>
          <Button variant="secondary" onClick={() => setImporting(true)}><FileSpreadsheet className="h-4 w-4" /> Pegar de Excel</Button>
          <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo insumo</Button>
        </>}
      />
      <label className="mb-3 inline-flex items-center gap-2 text-sm text-gray-400">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar dados de baja
      </label>
      {products.length === 0 ? (
        <div className="card p-6 text-sm text-gray-400">Sin insumos. Agrégalos uno por uno o pega tu lista de Excel.</div>
      ) : (
        <div className="card divide-y divide-gray-800/70">
          {products.map((p) => (
            <button key={p.id} type="button" onClick={() => setEditing(p)}
              className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-gray-900/60 ${p.active ? '' : 'opacity-50'}`}>
              <span>
                <span className="font-medium text-white">{p.name}</span>
                {p.requires_photo && <Camera className="ml-2 inline h-3.5 w-3.5 text-gray-500" aria-label="Foto obligatoria al contar" />}
                <span className="block text-xs text-gray-500">
                  {[p.area_name || 'Sin área', p.supplier_name, p.units.length ? `Compra: ${p.units.map((u) => `${u.name} (${fmtQty(u.factor)} ${p.base_unit})`).join(', ')}` : null,
                    p.count_days ? `Se cuenta ${p.count_days.map((d) => WEEKDAYS[d - 1]).join(', ')}` : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="text-right text-sm tabular-nums text-gray-300">
                {formatMXN(p.unit_cost)} / {p.base_unit}
                {Number(p.min_stock) > 0 && <span className="block text-xs text-gray-500">mínimo {fmtQty(p.min_stock)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <ProductModal product={editing === 'new' ? null : editing} areas={areas} suppliers={suppliers}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
    </>
  );
}

function ProductModal({ product, areas, suppliers, onClose, onSaved }: {
  product: InvProduct | null; areas: InvArea[]; suppliers: InvSupplier[]; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: product?.name || '',
    base_unit: product?.base_unit || 'kg',
    area_id: product?.area_id || '',
    supplier_id: product?.supplier_id || '',
    unit_cost: product ? String(Number(product.unit_cost)) : '',
    min_stock: product ? String(Number(product.min_stock)) : '',
    daily_use: product ? String(Number(product.daily_use)) : '',
    requires_photo: product?.requires_photo || false,
    active: product?.active ?? true,
  });
  const [days, setDays] = useState<number[]>(product?.count_days || []);
  const [units, setUnits] = useState<InvUnit[]>(product?.units.map((u) => ({ ...u, factor: String(Number(u.factor)) })) || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      ...f,
      area_id: f.area_id || null,
      supplier_id: f.supplier_id || null,
      unit_cost: Number(f.unit_cost || 0),
      min_stock: Number(f.min_stock || 0),
      daily_use: Number(f.daily_use || 0),
      count_days: days.length ? days : null,
      units: units.filter((u) => u.name.trim()).map((u) => ({ name: u.name.trim(), factor: Number(u.factor), is_purchase: u.is_purchase })),
    };
    try {
      await api(product ? `/inventory/products/${product.id}` : '/inventory/products', { method: product ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!product || !window.confirm(`¿Dar de baja "${product.name}"? Su historial se conserva.`)) return;
    try {
      await api(`/inventory/products/${product.id}`, { method: 'DELETE' });
      onSaved();
    } catch (err) { setError(errorMessage(err)); }
  };

  return (
    <Modal title={product ? 'Editar insumo' : 'Nuevo insumo'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Nombre"><input className="input" required maxLength={120} value={f.name} onChange={(e) => set('name')(e.target.value)} /></Field>
          <Field label="Unidad base" hint="En la que se cuenta y se gasta en recetas">
            <input className="input" required maxLength={40} list="inv-units" value={f.base_unit} onChange={(e) => set('base_unit')(e.target.value)} />
            <datalist id="inv-units">{['kg', 'g', 'l', 'ml', 'pza', 'paquete', 'caja'].map((u) => <option key={u} value={u} />)}</datalist>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Área de almacén">
            <select className="input" value={f.area_id} onChange={(e) => set('area_id')(e.target.value)}>
              <option value="">Sin área</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Proveedor">
            <select className="input" value={f.supplier_id} onChange={(e) => set('supplier_id')(e.target.value)}>
              <option value="">Sin proveedor</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={`Costo por ${f.base_unit || 'unidad'}`}>
            <input className="input" type="number" min="0" step="any" value={f.unit_cost} onChange={(e) => set('unit_cost')(e.target.value)} />
          </Field>
          <Field label="Mínimo">
            <input className="input" type="number" min="0" step="any" value={f.min_stock} onChange={(e) => set('min_stock')(e.target.value)} />
          </Field>
          <Field label="Consumo diario">
            <input className="input" type="number" min="0" step="any" value={f.daily_use} onChange={(e) => set('daily_use')(e.target.value)} />
          </Field>
        </div>

        <div>
          <span className="label">Unidades de compra</span>
          <div className="space-y-2">
            {units.map((u, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input className="input w-32 flex-1" placeholder="Caja, bulto…" value={u.name} aria-label="Nombre de la unidad"
                  onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <span className="text-sm text-gray-500">=</span>
                <input className="input w-24" type="number" min="0" step="any" value={u.factor} aria-label="Equivale a"
                  onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)))} />
                <span className="text-sm text-gray-500">{f.base_unit}</span>
                <label className="inline-flex items-center gap-1 text-xs text-gray-400">
                  <input type="radio" name="purchase-unit" checked={u.is_purchase}
                    onChange={() => setUnits(units.map((x, j) => ({ ...x, is_purchase: j === i })))} /> Se compra así
                </label>
                <button type="button" className="p-1 text-gray-500 hover:text-red-300" aria-label="Quitar unidad"
                  onClick={() => setUnits(units.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            {units.length < 10 && (
              <button type="button" className="text-sm text-brand hover:underline"
                onClick={() => setUnits([...units, { name: '', factor: '', is_purchase: units.length === 0 }])}>+ Agregar unidad</button>
            )}
          </div>
        </div>

        <div>
          <span className="label">Días en que se cuenta</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d, i) => {
              const on = days.includes(i + 1);
              return (
                <button key={d} type="button" aria-pressed={on}
                  onClick={() => setDays(on ? days.filter((x) => x !== i + 1) : [...days, i + 1].sort())}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-brand bg-brand/10 text-white' : 'border-gray-700 text-gray-400'}`}>{d}</button>
              );
            })}
          </div>
          <span className="mt-1 block text-xs text-gray-500">{days.length ? '' : 'Ninguno marcado: se cuenta todos los días.'}</span>
        </div>

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <Toggle checked={f.requires_photo} onChange={set('requires_photo')} label="Foto obligatoria" /> Foto obligatoria al contar
          </label>
          {product && (
            <label className="flex items-center gap-3 text-sm text-gray-300">
              <Toggle checked={f.active} onChange={set('active')} label="Activo" /> Activo
            </label>
          )}
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-between gap-2">
          {product?.active ? <Button type="button" variant="ghost" onClick={remove}><Trash2 className="h-4 w-4" /> Dar de baja</Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={busy}>Guardar</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

const IMPORT_COLS = ['name', 'base_unit', 'area', 'supplier', 'unit_cost', 'min_stock', 'daily_use'] as const;

/** Columnas: Nombre, Unidad, Área, Proveedor, Costo, Mínimo, Consumo diario (separadas por tabulador o coma). */
function parseImport(text: string) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(l.includes('\t') ? '\t' : ',').map((c) => c.trim()))
    .filter((cells, i) => !(i === 0 && /nombre|insumo/i.test(cells[0])))
    .map((cells) => {
      const row: Record<string, string | number> = {};
      IMPORT_COLS.forEach((k, i) => {
        const v = cells[i];
        if (v === undefined || v === '') return;
        row[k] = ['unit_cost', 'min_stock', 'daily_use'].includes(k) ? Number(v.replace(/[$,]/g, '')) : v;
      });
      if (!row.base_unit) row.base_unit = 'pza';
      return row;
    });
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null);
  const rows = parseImport(text);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api('/inventory/products/import', { method: 'POST', body: { products: rows } }));
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  return (
    <Modal title="Pegar insumos de Excel" onClose={result ? onDone : onClose} wide>
      {result ? (
        <div className="space-y-4">
          <Alert kind="success">Listo: {result.created} nuevos y {result.updated} actualizados.</Alert>
          <div className="flex justify-end"><Button onClick={onDone}>Cerrar</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Copia de Excel las columnas <b>Nombre, Unidad, Área, Proveedor, Costo, Mínimo, Consumo diario</b> (en ese orden) y pégalas aquí.
            Las áreas y proveedores que no existan se crean; si el insumo ya existe se actualiza.
          </p>
          <textarea className="input h-48 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'Salmón\tkg\tCongelador\tPescados del Norte\t420\t5\t2\nArroz\tkg\tSeco\t\t28\t20\t8'} aria-label="Insumos" />
          <p className="text-xs text-gray-500">{rows.length} renglones listos.</p>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button onClick={submit} loading={busy} disabled={!rows.length}>Importar</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
