import { Pencil, Plus, Ticket } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { num } from './lib';
import type { Menu } from './types';

interface Voucher {
  id: string; code: string; description: string | null; kind: 'monto' | 'porcentaje' | 'producto';
  amount: string | null; percent: string | null; menu_item_id: string | null; min_amount: string; max_uses: number | null;
  starts_on: string | null; ends_on: string | null; applies_pos: boolean; applies_web: boolean; active: boolean;
  uses: number; discounted: string;
}

/** Vales y codigos promocionales (como los "Vales" de Horom): en caja con el boton "Vale" y en el checkout en linea. */
export default function VouchersSection({ menu }: { menu: Menu | null }) {
  const [list, setList] = useState<Voucher[] | null>(null);
  const [editing, setEditing] = useState<Voucher | 'new' | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ vouchers: Voucher[] }>('/pos/vouchers').then((r) => setList(r.vouchers)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  const what = (v: Voucher) => (v.kind === 'monto' ? `${formatMXN(v.amount)} de descuento` : v.kind === 'porcentaje' ? `${num(v.percent)}% de descuento`
    : `${menu?.items.find((i) => i.id === v.menu_item_id)?.name || 'Producto'} gratis`);

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Vales y códigos</h2>
          <p className="text-sm text-gray-400">Un código que el cliente dice en caja o escribe al pedir en línea.</p>
        </div>
        <Button variant="secondary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo vale</Button>
      </div>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!list ? <Spinner /> : list.length === 0 ? <p className="card p-6 text-center text-sm text-gray-500">Sin vales. Ejemplo: BIENVENIDA = $50 en tu primera compra de más de $200.</p> : (
        <div className="card divide-y divide-gray-800">
          {list.map((v) => (
            <div key={v.id} className={`flex items-center gap-3 px-4 py-3 text-sm ${v.active ? '' : 'opacity-50'}`}>
              <Ticket className="h-5 w-5 text-brand" />
              <div className="flex-1">
                <p className="font-mono font-semibold tracking-wider text-white">{v.code}</p>
                <p className="text-xs text-gray-400">{what(v)}{num(v.min_amount) ? ` · compra mín. ${formatMXN(v.min_amount)}` : ''}{v.ends_on ? ` · hasta ${v.ends_on}` : ''}{!v.applies_pos ? ' · solo en línea' : !v.applies_web ? ' · solo en caja' : ''}</p>
              </div>
              <span className="text-right text-xs text-gray-400">{v.uses}{v.max_uses ? ` de ${v.max_uses}` : ''} usos<span className="block">{formatMXN(v.discounted)}</span></span>
              <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(v)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
      {editing && menu && <VoucherModal voucher={editing === 'new' ? null : editing} menu={menu} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function VoucherModal({ voucher: v, menu, onClose, onSaved }: { voucher: Voucher | null; menu: Menu; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    code: v?.code || '', description: v?.description || '', kind: v?.kind || 'monto' as Voucher['kind'],
    amount: v?.amount ? String(num(v.amount)) : '', percent: v?.percent ? String(num(v.percent)) : '', menu_item_id: v?.menu_item_id || '',
    min_amount: v ? String(num(v.min_amount)) : '0', max_uses: v?.max_uses ? String(v.max_uses) : '',
    starts_on: v?.starts_on || '', ends_on: v?.ends_on || '', applies_pos: v?.applies_pos ?? true, applies_web: v?.applies_web ?? true, active: v?.active ?? true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(v ? `/pos/vouchers/${v.id}` : '/pos/vouchers', {
        method: v ? 'PATCH' : 'POST',
        body: {
          ...f, description: f.description || null,
          amount: f.kind === 'monto' ? num(f.amount) : null, percent: f.kind === 'porcentaje' ? num(f.percent) : null,
          menu_item_id: f.kind === 'producto' ? f.menu_item_id || null : null,
          min_amount: num(f.min_amount), max_uses: f.max_uses ? Math.trunc(num(f.max_uses)) : null,
          starts_on: f.starts_on || null, ends_on: f.ends_on || null,
        },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={v ? `Vale ${v.code}` : 'Nuevo vale'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Código"><input className="input font-mono uppercase tracking-wider" required maxLength={30} value={f.code} placeholder="BIENVENIDA" onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Da">
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Voucher['kind'] })}>
              <option value="monto">$ de descuento</option>
              <option value="porcentaje">% de descuento</option>
              <option value="producto">Un producto gratis</option>
            </select>
          </Field>
          {f.kind === 'monto' && <Field label="Descuento ($)"><input className="input" type="number" min="1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>}
          {f.kind === 'porcentaje' && <Field label="Descuento (%)"><input className="input" type="number" min="1" max="100" step="0.01" required value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field>}
          {f.kind === 'producto' && (
            <Field label="Producto gratis" hint="Debe venir en la orden">
              <select className="input" required value={f.menu_item_id} onChange={(e) => setF({ ...f, menu_item_id: e.target.value })}>
                <option value="">Elige…</option>
                {menu.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Compra mínima ($)"><input className="input" type="number" min="0" step="0.01" value={f.min_amount} onChange={(e) => setF({ ...f, min_amount: e.target.value })} /></Field>
          <Field label="Usos máximos" hint="Vacío = ilimitado"><input className="input" type="number" min="1" step="1" value={f.max_uses} onChange={(e) => setF({ ...f, max_uses: e.target.value })} /></Field>
          <Field label="Vence el" hint="Opcional"><input className="input" type="date" value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
        </div>
        <Field label="Descripción (interna)"><input className="input" maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-gray-300">
          <label className="flex items-center gap-2"><Toggle label="En caja" checked={f.applies_pos} onChange={(x) => setF({ ...f, applies_pos: x })} /> En caja</label>
          <label className="flex items-center gap-2"><Toggle label="En línea" checked={f.applies_web} onChange={(x) => setF({ ...f, applies_web: x })} /> En línea</label>
          <label className="flex items-center gap-2"><Toggle label="Activo" checked={f.active} onChange={(x) => setF({ ...f, active: x })} /> Activo</label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
