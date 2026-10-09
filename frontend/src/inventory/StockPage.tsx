import { AlertTriangle, History, Minus, Search, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { downloadCsv } from '../lib/csv';
import { Stat } from '../pos/ReportsPage';
import { useInv } from './context';
import { KIND_LABEL, fmtQty, unitOptions } from './lib';
import type { Movement, StockRow } from './types';

/** Existencias de la sucursal: valor, bajo minimo, dias que alcanza, mermas y kardex. */
export default function StockPage() {
  const { branchId, manager } = useInv();
  const [data, setData] = useState<{ products: StockRow[]; total_value: number; cover_days: number } | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [area, setArea] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [moving, setMoving] = useState<{ kind: 'merma' | 'ajuste'; product?: StockRow } | null>(null);
  const [kardex, setKardex] = useState<StockRow | 'all' | null>(null);

  const load = useCallback(() => {
    api<typeof data>(`/inventory/stock?branch_id=${branchId}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(() => { setData(null); load(); }, [load]);

  const areas = useMemo(() => [...new Set((data?.products || []).map((p) => p.area_name || 'Sin área'))], [data]);
  const rows = useMemo(() => (data?.products || []).filter((p) =>
    (!q || p.name.toLowerCase().includes(q.toLowerCase()))
    && (!area || (p.area_name || 'Sin área') === area)
    && (!lowOnly || p.below_min)), [data, q, area, lowOnly]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const low = data.products.filter((p) => p.below_min).length;

  const csv = () => downloadCsv('existencias', ['Insumo', 'Área', 'Existencia', 'Unidad', 'Mínimo', 'Costo unitario', 'Valor'],
    rows.map((p) => [p.name, p.area_name || '', p.quantity, p.base_unit, Number(p.min_stock), Number(p.unit_cost), p.value]));

  return (
    <>
      <PageHeader
        title="Existencias"
        subtitle="Lo que hay en la sucursal según conteos, compras, ventas por receta y mermas."
        actions={<>
          <Button variant="secondary" onClick={() => setKardex('all')}><History className="h-4 w-4" /> Movimientos</Button>
          <Button variant="secondary" onClick={() => setMoving({ kind: 'merma' })}><Minus className="h-4 w-4" /> Merma</Button>
          {manager && <Button variant="secondary" onClick={() => setMoving({ kind: 'ajuste' })}><SlidersHorizontal className="h-4 w-4" /> Ajuste</Button>}
        </>}
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Valor del inventario" value={formatMXN(data.total_value)} />
        <Stat label="Insumos" value={String(data.products.length)} />
        <Stat label="Bajo el mínimo" value={String(low)}
          extra={low > 0 && <button type="button" className="text-xs text-amber-300 hover:underline" onClick={() => setLowOnly(true)}>Ver cuáles</button>} />
      </div>

      {data.products.length === 0 ? (
        <div className="card p-6 text-sm text-gray-400">
          Todavía no hay insumos. {manager ? 'Dalos de alta en la pestaña Insumos (puedes pegarlos desde Excel).' : 'Pide a un gerente que los dé de alta.'}
        </div>
      ) : (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 p-3">
            <label className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input className="input pl-9" placeholder="Buscar insumo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar insumo" />
            </label>
            {areas.length > 1 && (
              <select className="input w-auto" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Área">
                <option value="">Todas las áreas</option>
                {areas.map((a) => <option key={a}>{a}</option>)}
              </select>
            )}
            <label className="inline-flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Solo bajo mínimo
            </label>
            <button type="button" onClick={csv} className="ml-auto text-xs text-gray-400 hover:text-white">Descargar CSV</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-2 font-medium">Insumo</th>
                  <th className="px-4 py-2 text-right font-medium">Existencia</th>
                  <th className="px-4 py-2 text-right font-medium">Mínimo</th>
                  <th className="px-4 py-2 text-right font-medium">Alcanza</th>
                  <th className="px-4 py-2 text-right font-medium">Valor</th>
                  <th className="px-4 py-2 text-right font-medium">Pedir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/70">
                {rows.map((p) => (
                  <tr key={p.id} className="cursor-pointer text-gray-200 hover:bg-gray-900/60" onClick={() => setKardex(p)}>
                    <td className="px-4 py-2">
                      <span className="font-medium text-white">{p.name}</span>
                      <span className="block text-xs text-gray-500">{p.area_name || 'Sin área'}{p.last_count_at ? ` · contado ${formatDateTime(p.last_count_at)}` : ''}</span>
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${p.below_min ? 'text-amber-300' : ''}`}>
                      {p.below_min && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-label="Bajo el mínimo" />}
                      {fmtQty(p.quantity)} {p.base_unit}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-400">{Number(p.min_stock) ? fmtQty(p.min_stock) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-400">{p.days_left === null ? '—' : `${p.days_left} d`}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMXN(p.value)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-300">
                      {p.suggested ? `${p.suggested.quantity} ${p.suggested.unit}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="px-4 py-6 text-sm text-gray-500">Ningún insumo coincide.</p>}
          </div>
        </section>
      )}

      {moving && (
        <MovementModal kind={moving.kind} products={data.products} initial={moving.product} branchId={branchId}
          onClose={() => setMoving(null)} onSaved={() => { setMoving(null); load(); }} />
      )}
      {kardex && (
        <KardexModal product={kardex === 'all' ? null : kardex} branchId={branchId} onClose={() => setKardex(null)}
          onWaste={kardex !== 'all' ? () => { setMoving({ kind: 'merma', product: kardex }); setKardex(null); } : undefined} />
      )}
    </>
  );
}

function MovementModal({ kind, products, initial, branchId, onClose, onSaved }: {
  kind: 'merma' | 'ajuste'; products: StockRow[]; initial?: StockRow; branchId: string; onClose: () => void; onSaved: () => void;
}) {
  const [productId, setProductId] = useState(initial?.id || '');
  const product = products.find((p) => p.id === productId);
  const [unit, setUnit] = useState(initial?.base_unit || '');
  const [quantity, setQuantity] = useState('');
  const [sign, setSign] = useState<1 | -1>(-1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/inventory/movements', {
        method: 'POST',
        body: { branch_id: branchId, kind, product_id: productId, unit: unit || undefined, reason, quantity: kind === 'ajuste' ? sign * Number(quantity) : Number(quantity) },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={kind === 'merma' ? 'Registrar merma' : 'Ajuste de existencia'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Insumo">
          <select className="input" value={productId} required
            onChange={(e) => { setProductId(e.target.value); setUnit(products.find((p) => p.id === e.target.value)?.base_unit || ''); }}>
            <option value="">Elige…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {product && <p className="text-xs text-gray-500">Existencia actual: {fmtQty(product.quantity)} {product.base_unit}</p>}
        {kind === 'ajuste' && (
          <div className="flex gap-2">
            {([[1, 'Sumar'], [-1, 'Restar']] as const).map(([s, label]) => (
              <button key={s} type="button" onClick={() => setSign(s)}
                className={`flex-1 rounded-xl border px-3 py-2 text-sm ${sign === s ? 'border-brand bg-brand/10 text-white' : 'border-gray-700 text-gray-400'}`}>{label}</button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cantidad">
            <input className="input" type="number" min="0" step="any" inputMode="decimal" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Unidad">
            <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!product}>
              {product && unitOptions(product).map((u) => <option key={u.name} value={u.name}>{u.name}{u.factor !== 1 ? ` (${fmtQty(u.factor)} ${product.base_unit})` : ''}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Motivo">
          <input className="input" required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder={kind === 'merma' ? 'Se echó a perder, se cayó, caducó…' : 'Corrección de captura…'} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function KardexModal({ product, branchId, onClose, onWaste }: {
  product: StockRow | null; branchId: string; onClose: () => void; onWaste?: () => void;
}) {
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const qs = new URLSearchParams({ branch_id: branchId, limit: '200' });
    if (product) qs.set('product_id', product.id);
    api<{ movements: Movement[] }>(`/inventory/movements?${qs}`).then((r) => setRows(r.movements)).catch((e) => setError(errorMessage(e)));
  }, [branchId, product]);
  return (
    <Modal title={product ? `Kardex · ${product.name}` : 'Últimos movimientos'} onClose={onClose} wide>
      {product && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-400">
          <span>Existencia: <b className="text-white">{fmtQty(product.quantity)} {product.base_unit}</b> · Costo {formatMXN(product.unit_cost)} / {product.base_unit}</span>
          {onWaste && <Button variant="secondary" onClick={onWaste}><Minus className="h-4 w-4" /> Merma</Button>}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {!rows && !error && <Spinner />}
      {rows && !rows.length && <p className="text-sm text-gray-500">Sin movimientos todavía.</p>}
      {rows && rows.length > 0 && (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                <th className="py-2 pr-3 font-medium">Fecha</th>
                {!product && <th className="py-2 pr-3 font-medium">Insumo</th>}
                <th className="py-2 pr-3 font-medium">Tipo</th>
                <th className="py-2 pr-3 text-right font-medium">Cantidad</th>
                <th className="py-2 text-right font-medium">Queda</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70">
              {rows.map((m) => {
                const n = Number(m.quantity);
                return (
                  <tr key={m.id} className="align-top text-gray-200">
                    <td className="whitespace-nowrap py-2 pr-3 text-gray-400">{formatDateTime(m.created_at)}</td>
                    {!product && <td className="py-2 pr-3">{m.product_name}</td>}
                    <td className="py-2 pr-3">
                      {KIND_LABEL[m.kind]}
                      {(m.reason || m.created_by_name) && (
                        <span className="block text-xs text-gray-500">{[m.reason, m.created_by_name].filter(Boolean).join(' · ')}</span>
                      )}
                    </td>
                    <td className={`whitespace-nowrap py-2 pr-3 text-right tabular-nums ${n < 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                      {n > 0 ? '+' : ''}{fmtQty(n)} {m.base_unit}
                    </td>
                    <td className="whitespace-nowrap py-2 text-right tabular-nums">{fmtQty(m.balance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
