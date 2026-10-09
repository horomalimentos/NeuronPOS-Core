import { CheckCircle2, MessageCircle, PackageCheck, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import ImageInput from '../components/ImageInput';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { useInv } from './context';
import { PO_STATUS_LABEL, PO_STATUS_STYLE, fmtQty, unitOptions, whatsappLink } from './lib';
import type { InvProduct, InvSupplier, PurchaseOrder, Suggestion } from './types';

interface Line { product_id: string; quantity: string; unit: string; unit_price: string }

/**
 * Compras: pedido sugerido por proveedor (existencia contra minimo y consumo),
 * solicitudes del personal, aprobacion, envio por WhatsApp y recepcion con
 * precio real (actualiza el costo del insumo y la existencia).
 */
export default function PurchasesPage() {
  const { branchId, manager } = useInv();
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [filter, setFilter] = useState<'abiertas' | ''>('abiertas');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ supplierId: string; lines: Line[] } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ branch_id: branchId });
    if (filter) qs.set('status', filter);
    api<{ orders: PurchaseOrder[] }>(`/inventory/purchase-orders?${qs}`).then((r) => setOrders(r.orders)).catch((e) => setError(errorMessage(e)));
  }, [branchId, filter]);
  useEffect(() => { setOrders(null); load(); }, [load]);

  return (
    <>
      <PageHeader
        title="Compras"
        subtitle={manager ? 'Solicitudes del personal, órdenes a proveedores y recepción de mercancía.' : 'Pide lo que hace falta; un gerente lo aprueba.'}
        actions={<>
          <Button variant="secondary" onClick={() => setSuggesting(true)}><Sparkles className="h-4 w-4" /> Pedido sugerido</Button>
          <Button onClick={() => setEditor({ supplierId: '', lines: [] })}><Plus className="h-4 w-4" /> {manager ? 'Nueva orden' : 'Nueva solicitud'}</Button>
        </>}
      />
      <div className="mb-3 flex gap-2">
        {([['abiertas', 'Pendientes'], ['', 'Todas']] as const).map(([k, label]) => (
          <button key={label} type="button" onClick={() => setFilter(k)}
            className={`rounded-full px-3 py-1 text-sm ${filter === k ? 'bg-brand text-brand-contrast' : 'bg-gray-800 text-gray-300'}`}>{label}</button>
        ))}
      </div>
      {error && <Alert>{error}</Alert>}
      {!orders && !error && <Spinner />}
      {orders && orders.length === 0 && <div className="card p-6 text-sm text-gray-400">{filter ? 'No hay compras pendientes.' : 'Todavía no hay compras.'}</div>}
      {orders && orders.length > 0 && (
        <div className="card divide-y divide-gray-800/70">
          {orders.map((o) => (
            <button key={o.id} type="button" onClick={() => setOpenId(o.id)}
              className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-gray-900/60">
              <span>
                <span className="font-medium text-white">#{o.folio} · {o.supplier_name || 'Sin proveedor'}</span>
                <span className="block text-xs text-gray-500">{o.items_count} insumos · {o.created_by_name} · {formatDateTime(o.created_at)}</span>
              </span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-gray-200">{formatMXN(o.total)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${PO_STATUS_STYLE[o.status]}`}>{PO_STATUS_LABEL[o.status]}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {suggesting && (
        <SuggestionsModal branchId={branchId} onClose={() => setSuggesting(false)}
          onPick={(s) => {
            setSuggesting(false);
            setEditor({
              supplierId: s.supplier_id || '',
              lines: s.items.map((i) => ({ product_id: i.product_id, quantity: String(i.quantity), unit: i.unit, unit_price: String(i.unit_price) })),
            });
          }} />
      )}
      {editor && (
        <OrderEditor branchId={branchId} manager={manager} initial={editor} onClose={() => setEditor(null)}
          onSaved={(o) => { setEditor(null); load(); setOpenId(o.id); }} />
      )}
      {openId && <OrderModal id={openId} manager={manager} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}

function SuggestionsModal({ branchId, onClose, onPick }: { branchId: string; onClose: () => void; onPick: (s: Suggestion) => void }) {
  const [data, setData] = useState<{ cover_days: number; suppliers: Suggestion[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<typeof data>(`/inventory/purchase-suggestions?branch_id=${branchId}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  return (
    <Modal title="Pedido sugerido" onClose={onClose} wide>
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Spinner />}
      {data && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Lo que falta para llegar al mínimo o para cubrir {data.cover_days} días de consumo, según la existencia actual.
          </p>
          {data.suppliers.length === 0 && <Alert kind="success">No hace falta pedir nada por ahora.</Alert>}
          {data.suppliers.map((s) => {
            const total = s.items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
            return (
              <section key={s.supplier_id || 'sin'} className="rounded-xl border border-gray-800">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 px-4 py-2">
                  <span className="font-medium text-white">{s.supplier_name}</span>
                  <Button variant="secondary" onClick={() => onPick(s)}>Armar orden · {formatMXN(total)}</Button>
                </div>
                <ul className="divide-y divide-gray-800/70 text-sm">
                  {s.items.map((i) => (
                    <li key={i.product_id} className="flex justify-between gap-2 px-4 py-2 text-gray-300">
                      <span>{i.name} <span className="text-xs text-gray-500">(hay {fmtQty(i.stock)} {i.base_unit})</span></span>
                      <span className="tabular-nums">{i.quantity} {i.unit}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function OrderEditor({ branchId, manager, initial, onClose, onSaved }: {
  branchId: string; manager: boolean; initial: { supplierId: string; lines: Line[] };
  onClose: () => void; onSaved: (o: PurchaseOrder) => void;
}) {
  const [products, setProducts] = useState<InvProduct[] | null>(null);
  const [suppliers, setSuppliers] = useState<InvSupplier[]>([]);
  const [supplierId, setSupplierId] = useState(initial.supplierId);
  const [lines, setLines] = useState<Line[]>(initial.lines);
  const [notes, setNotes] = useState('');
  const [approve, setApprove] = useState(manager);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<{ products: InvProduct[] }>('/inventory/products'), api<{ suppliers: InvSupplier[] }>('/inventory/suppliers')])
      .then(([p, s]) => { setProducts(p.products); setSuppliers(s.suppliers); })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const byId = new Map((products || []).map((p) => [p.id, p]));
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addProduct = (id: string) => {
    const p = byId.get(id);
    if (!p || lines.some((l) => l.product_id === id)) return;
    const pu = p.units.find((u) => u.is_purchase);
    const factor = pu ? Number(pu.factor) : 1;
    setLines([...lines, { product_id: id, quantity: '1', unit: pu?.name || p.base_unit, unit_price: String(Math.round(Number(p.unit_cost) * factor * 100) / 100) }]);
  };
  const total = lines.reduce((a, l) => a + Number(l.quantity || 0) * Number(l.unit_price || 0), 0);
  // Al elegir proveedor se sugieren primero sus insumos.
  const available = (products || []).filter((p) => !lines.some((l) => l.product_id === p.id))
    .sort((a, b) => Number(b.supplier_id === supplierId) - Number(a.supplier_id === supplierId));

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ order: PurchaseOrder }>('/inventory/purchase-orders', {
        method: 'POST',
        body: {
          branch_id: branchId, supplier_id: supplierId || null, notes: notes || null, approve,
          items: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit: l.unit, unit_price: Number(l.unit_price || 0) })),
        },
      });
      onSaved(r.order);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={manager ? 'Orden de compra' : 'Solicitud de compra'} onClose={onClose} wide>
      {!products ? (error ? <Alert>{error}</Alert> : <Spinner />) : (
        <div className="space-y-4">
          <Field label="Proveedor">
            <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Sin proveedor</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <div className="space-y-2">
            {lines.map((l, i) => {
              const p = byId.get(l.product_id);
              if (!p) return null;
              return (
                <div key={l.product_id} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 p-2">
                  <span className="min-w-[8rem] flex-1 text-sm text-white">{p.name}</span>
                  <input className="input w-20 text-right" type="number" min="0" step="any" value={l.quantity} aria-label={`Cantidad de ${p.name}`}
                    onChange={(e) => update(i, { quantity: e.target.value })} />
                  <select className="input w-auto" value={l.unit} aria-label={`Unidad de ${p.name}`} onChange={(e) => update(i, { unit: e.target.value })}>
                    {unitOptions(p).map((u) => <option key={u.name}>{u.name}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-gray-500">$
                    <input className="input w-24 text-right" type="number" min="0" step="any" value={l.unit_price} aria-label={`Precio de ${p.name}`}
                      onChange={(e) => update(i, { unit_price: e.target.value })} />
                  </label>
                  <button type="button" className="p-1 text-gray-500 hover:text-red-300" aria-label={`Quitar ${p.name}`}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
                </div>
              );
            })}
            <select className="input" value="" onChange={(e) => addProduct(e.target.value)} aria-label="Agregar insumo">
              <option value="">+ Agregar insumo…</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.name}{p.supplier_name ? ` · ${p.supplier_name}` : ''}</option>)}
            </select>
          </div>
          <Field label="Notas"><input className="input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {manager && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} /> Aprobarla de una vez
            </label>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-gray-400">Total estimado: <b className="tabular-nums text-white">{formatMXN(total)}</b></span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>Cancelar</Button>
              <Button onClick={submit} loading={busy} disabled={!lines.length}>{manager ? 'Guardar orden' : 'Enviar solicitud'}</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function orderText(o: PurchaseOrder, restaurant: string) {
  const lines = (o.items || []).map((i) => `• ${fmtQty(i.quantity)} ${i.unit_name} de ${i.name}`);
  return [`Hola${o.supplier_name ? ` ${o.supplier_name}` : ''}, pedido #${o.folio} de ${restaurant} (${o.branch_name}):`, ...lines,
    o.notes ? `Notas: ${o.notes}` : '', 'Gracias.'].filter(Boolean).join('\n');
}

function OrderModal({ id, manager, onClose, onChanged }: { id: string; manager: boolean; onClose: () => void; onChanged: () => void }) {
  const { me } = useInv();
  const [o, setO] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [received, setReceived] = useState<Record<string, { quantity: string; price: string }>>({});
  const [receipt, setReceipt] = useState('');

  useEffect(() => {
    api<{ order: PurchaseOrder }>(`/inventory/purchase-orders/${id}`).then((r) => setO(r.order)).catch((e) => setError(errorMessage(e)));
  }, [id]);

  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ order: PurchaseOrder }>(`/inventory/purchase-orders/${id}/${path}`, { method: 'POST', body });
      setO(r.order);
      setReceiving(false);
      onChanged();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };

  const cancel = () => {
    const reason = window.prompt('¿Por qué se cancela?');
    if (reason?.trim()) run('cancel', { reason: reason.trim() });
  };

  const startReceive = () => {
    setReceived(Object.fromEntries((o?.items || []).map((i) => [i.product_id, { quantity: String(Number(i.quantity)), price: String(Number(i.unit_price)) }])));
    setReceiving(true);
  };

  if (!o) return <Modal title="Compra" onClose={onClose}>{error ? <Alert>{error}</Alert> : <Spinner />}</Modal>;
  const isOpen = o.status === 'solicitada' || o.status === 'aprobada';
  const receiveTotal = Object.values(received).reduce((a, r) => a + Number(r.quantity || 0) * Number(r.price || 0), 0);

  return (
    <Modal title={`Compra #${o.folio}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-400">
          <span>{o.supplier_name || 'Sin proveedor'} · {o.branch_name}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${PO_STATUS_STYLE[o.status]}`}>{PO_STATUS_LABEL[o.status]}</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
              <th className="py-2 pr-2 font-medium">Insumo</th>
              <th className="py-2 pr-2 text-right font-medium">{receiving ? 'Llegó' : 'Cantidad'}</th>
              <th className="py-2 pr-2 text-right font-medium">Precio</th>
              <th className="py-2 text-right font-medium">Importe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70">
            {(o.items || []).map((i) => {
              const r = received[i.product_id];
              const q = receiving ? Number(r?.quantity || 0) : Number(i.received_quantity ?? i.quantity);
              const price = receiving ? Number(r?.price || 0) : Number(i.unit_price);
              return (
                <tr key={i.id} className="text-gray-200">
                  <td className="py-2 pr-2">{i.name}<span className="block text-xs text-gray-500">{i.unit_name}{Number(i.unit_factor) !== 1 ? ` = ${fmtQty(i.unit_factor)} ${i.base_unit}` : ''}</span></td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {receiving ? (
                      <input className="input ml-auto w-20 text-right" type="number" min="0" step="any" value={r?.quantity ?? ''} aria-label={`Llegó de ${i.name}`}
                        onChange={(e) => setReceived({ ...received, [i.product_id]: { ...r, quantity: e.target.value } })} />
                    ) : <>{fmtQty(q)}{i.received_quantity !== null && Number(i.received_quantity) !== Number(i.quantity) && <span className="block text-xs text-amber-300">pedido {fmtQty(i.quantity)}</span>}</>}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {receiving ? (
                      <input className="input ml-auto w-24 text-right" type="number" min="0" step="any" value={r?.price ?? ''} aria-label={`Precio de ${i.name}`}
                        onChange={(e) => setReceived({ ...received, [i.product_id]: { ...r, price: e.target.value } })} />
                    ) : formatMXN(price)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatMXN(q * price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-right text-sm text-gray-400">Total: <b className="tabular-nums text-white">{formatMXN(receiving ? receiveTotal : o.total)}</b></p>
        {o.notes && <p className="text-sm text-gray-400">Notas: {o.notes}</p>}
        <p className="text-xs text-gray-500">
          {[`Pidió ${o.created_by_name || '—'} el ${formatDateTime(o.created_at)}`,
            o.approved_by_name && `aprobó ${o.approved_by_name}`,
            o.received_by_name && `recibió ${o.received_by_name} el ${formatDateTime(o.received_at)}`,
            o.cancelled_reason && `cancelada: ${o.cancelled_reason}`].filter(Boolean).join(' · ')}
        </p>
        {o.receipt_url && <a href={o.receipt_url} target="_blank" rel="noreferrer" className="text-sm text-brand hover:underline">Ver nota o factura</a>}
        {receiving && <ImageInput label="Foto de la nota (opcional)" value={receipt} onChange={setReceipt} />}
        {error && <Alert>{error}</Alert>}

        {isOpen && (
          <div className="flex flex-wrap justify-end gap-2">
            {receiving ? (
              <>
                <Button variant="ghost" onClick={() => setReceiving(false)}>Volver</Button>
                <Button loading={busy} onClick={() => run('receive', {
                  receipt_url: receipt || undefined,
                  items: Object.entries(received).map(([productId, r]) => ({ product_id: productId, received_quantity: Number(r.quantity || 0), unit_price: Number(r.price || 0) })),
                })}><PackageCheck className="h-4 w-4" /> Confirmar recepción</Button>
              </>
            ) : (
              <>
                {(manager || o.status === 'solicitada') && <Button variant="ghost" onClick={cancel} disabled={busy}><X className="h-4 w-4" /> Cancelar</Button>}
                <a href={whatsappLink(o.supplier_phone, orderText(o, me.restaurant.name))} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-100 hover:bg-gray-700">
                  <MessageCircle className="h-4 w-4" /> Enviar por WhatsApp
                </a>
                {manager && o.status === 'solicitada' && <Button variant="secondary" loading={busy} onClick={() => run('approve')}><CheckCircle2 className="h-4 w-4" /> Aprobar</Button>}
                {manager && <Button onClick={startReceive}><PackageCheck className="h-4 w-4" /> Recibir</Button>}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
