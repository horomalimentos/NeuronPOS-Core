import { ArrowLeft, Camera, CheckCircle2, Pause, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ImageInput from '../components/ImageInput';
import { Alert, Button, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { COUNT_STATUS_LABEL, fmtQty, unitOptions } from './lib';
import type { CountItem, CountProduct, InvCount } from './types';

interface Detail { count: InvCount; products: CountProduct[] }
interface Draft { quantity: string; unit: string }

/**
 * Captura guiada de un conteo: insumo por insumo, en la unidad que sea mas
 * comoda (cajas, kilos…). Es a ciegas: no muestra lo que dice el sistema
 * hasta terminar, para que el conteo sea real.
 */
export default function CountPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [all, setAll] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [photoFor, setPhotoFor] = useState<CountProduct | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Detail>(`/inventory/counts/${id}${all ? '?all=1' : ''}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [id, all]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const { count, products } = data;
  const open = count.status === 'en_progreso' || count.status === 'pausado';
  const done = products.filter((p) => p.item).length;

  const setItem = (productId: string, item: CountItem | null) =>
    setData((d) => d && { ...d, products: d.products.map((p) => (p.id === productId ? { ...p, item } : p)) });

  const save = async (p: CountProduct, photoUrl?: string) => {
    const d = drafts[p.id];
    const quantity = d ? d.quantity : p.item?.entered_quantity;
    if (quantity === undefined || quantity === '') return;
    setSaving(p.id);
    setError('');
    try {
      const r = await api<{ item: CountItem }>(`/inventory/counts/${count.id}/items/${p.id}`, {
        method: 'PUT',
        body: { quantity: Number(quantity), unit: d?.unit || p.item?.entered_unit || p.base_unit, photo_url: photoUrl },
      });
      setItem(p.id, r.item);
      setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== p.id)));
    } catch (err) { setError(`${p.name}: ${errorMessage(err)}`); }
    setSaving(null);
  };

  const action = async (what: 'pause' | 'cancel' | 'complete') => {
    if (what === 'cancel' && !window.confirm('¿Cancelar este conteo? Lo capturado no se aplica.')) return;
    if (what === 'complete' && Object.keys(drafts).length && !window.confirm('Hay cantidades sin guardar. ¿Terminar de todos modos?')) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<Detail | { count: InvCount }>(`/inventory/counts/${count.id}/${what}`, { method: 'POST' });
      if (what === 'pause') navigate('/admin/inventario/conteos');
      else if ('products' in r) setData(r);
      else load();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };

  return (
    <>
      <Link to="/admin/inventario/conteos" className="mb-3 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Conteos
      </Link>
      <PageHeader
        title={`Conteo · ${count.area_name || 'Todas las áreas'}`}
        subtitle={`${formatDay(count.count_date)} · ${COUNT_STATUS_LABEL[count.status]} · ${done} de ${products.length} capturados`}
        actions={open && <>
          <Button variant="ghost" onClick={() => action('cancel')} disabled={busy}><X className="h-4 w-4" /> Cancelar</Button>
          <Button variant="secondary" onClick={() => action('pause')} disabled={busy}><Pause className="h-4 w-4" /> Pausar</Button>
          <Button onClick={() => action('complete')} loading={busy}><CheckCircle2 className="h-4 w-4" /> Terminar</Button>
        </>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {open && (
        <label className="mb-3 inline-flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Mostrar también los que no tocan hoy
        </label>
      )}
      {products.length === 0 && <div className="card p-6 text-sm text-gray-400">No hay insumos que contar hoy en esta área.</div>}

      {open ? (
        <div className="card divide-y divide-gray-800/70">
          {products.map((p) => {
            const d = drafts[p.id];
            const value = d ? d.quantity : (p.item?.entered_quantity !== undefined ? String(Number(p.item.entered_quantity)) : '');
            const unit = d?.unit || p.item?.entered_unit || p.base_unit;
            const dirty = Boolean(d);
            const needsPhoto = p.requires_photo && !p.item?.photo_url;
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-[10rem] flex-1">
                  <span className="font-medium text-white">{p.name}</span>
                  {p.item && !dirty && <CheckCircle2 className="ml-2 inline h-4 w-4 text-emerald-400" aria-label="Capturado" />}
                  <span className="block text-xs text-gray-500">
                    {[p.area_name, p.requires_photo ? 'Foto obligatoria' : null, !p.scheduled ? 'No toca hoy' : null].filter(Boolean).join(' · ') || ' '}
                  </span>
                </div>
                <input className="input w-24 text-right" type="number" min="0" step="any" inputMode="decimal" value={value}
                  aria-label={`Cantidad de ${p.name}`}
                  onChange={(e) => setDrafts({ ...drafts, [p.id]: { quantity: e.target.value, unit } })}
                  onKeyDown={(e) => { if (e.key === 'Enter') save(p); }} />
                <select className="input w-28" value={unit} aria-label={`Unidad de ${p.name}`}
                  onChange={(e) => setDrafts({ ...drafts, [p.id]: { quantity: value, unit: e.target.value } })}>
                  {unitOptions(p).map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
                </select>
                <button type="button" onClick={() => setPhotoFor(p)} aria-label={`Foto de ${p.name}`}
                  className={`rounded-lg border p-2 ${p.item?.photo_url ? 'border-emerald-700 text-emerald-300' : needsPhoto ? 'border-amber-600 text-amber-300' : 'border-gray-700 text-gray-400'}`}>
                  <Camera className="h-4 w-4" />
                </button>
                <Button variant={dirty ? 'primary' : 'secondary'} onClick={() => save(p)} loading={saving === p.id} disabled={!dirty || value === ''}>
                  Guardar
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <Results products={products} />
      )}

      {photoFor && (
        <Modal title={`Foto · ${photoFor.name}`} onClose={() => setPhotoFor(null)}>
          <p className="mb-3 text-sm text-gray-400">Toma la foto de lo contado como evidencia.</p>
          <ImageInput value={photoFor.item?.photo_url || ''} onChange={async (url) => {
            const p = photoFor;
            setPhotoFor(null);
            if (!p.item && !drafts[p.id]) {
              setError(`${p.name}: captura primero la cantidad`);
              return;
            }
            await save(p, url);
          }} />
        </Modal>
      )}
    </>
  );
}

/** Al terminar: contado contra lo que esperaba el sistema, con la diferencia en dinero. */
function Results({ products }: { products: CountProduct[] }) {
  const rows = products.filter((p) => p.item);
  const diffCost = (p: CountProduct) => (Number(p.item!.quantity) - Number(p.item!.expected ?? p.item!.quantity)) * Number(p.unit_cost);
  const total = rows.reduce((a, p) => a + diffCost(p), 0);
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
        <h2 className="font-semibold text-white">Resultado</h2>
        <span className={`text-sm tabular-nums ${total < 0 ? 'text-red-300' : 'text-gray-300'}`}>Diferencia total: {formatMXN(total)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
              <th className="px-4 py-2 font-medium">Insumo</th>
              <th className="px-4 py-2 text-right font-medium">Sistema</th>
              <th className="px-4 py-2 text-right font-medium">Contado</th>
              <th className="px-4 py-2 text-right font-medium">Diferencia</th>
              <th className="px-4 py-2 text-right font-medium">$</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70">
            {rows.map((p) => {
              const it = p.item!;
              const diff = it.expected === null ? null : Number(it.quantity) - Number(it.expected);
              return (
                <tr key={p.id} className="text-gray-200">
                  <td className="px-4 py-2">
                    {p.name}
                    {it.photo_url && <a href={it.photo_url} target="_blank" rel="noreferrer" className="ml-2 text-xs text-brand hover:underline">foto</a>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-400">{it.expected === null ? '—' : fmtQty(it.expected)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtQty(it.quantity)} {p.base_unit}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${diff && diff < 0 ? 'text-red-300' : diff ? 'text-emerald-300' : ''}`}>
                    {diff === null ? '—' : `${diff > 0 ? '+' : ''}${fmtQty(diff)}`}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{diff === null ? '—' : formatMXN(diffCost(p))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="px-4 py-6 text-sm text-gray-500">No se capturó nada.</p>}
      </div>
    </section>
  );
}
