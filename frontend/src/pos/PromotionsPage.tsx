import { Gift, Pencil, Percent, Plus, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { useAdmin } from '../restaurant/context';
import { num, posCan } from './lib';
import VouchersSection from './VouchersSection';
import type { Menu, Promotion, PromotionKind } from './types';

/**
 * Promociones automaticas (como las de Horom): 2x1/3x2, paquetes, % o $ de
 * descuento y producto de regalo. Se aplican solas en la caja y en el pedido
 * en linea segun su horario.
 */

const KIND_LABEL: Record<PromotionKind, string> = {
  nxm: '2x1, 3x2…', paquete: 'Paquete a precio fijo', porcentaje: '% de descuento', monto: '$ de descuento a la cuenta', regalo: 'Producto de regalo',
};
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function describe(p: Promotion, menu: Menu | null): string {
  const names = [
    ...p.item_ids.map((id) => menu?.items.find((i) => i.id === id)?.name),
    ...p.category_ids.map((id) => menu?.categories.find((c) => c.id === id)?.name),
  ].filter(Boolean).join(', ') || 'todo el menú';
  const reward = menu?.items.find((i) => i.id === p.reward_item_id)?.name || 'un producto';
  const what = {
    nxm: `${p.buy_quantity}x${p.pay_quantity} en ${names}`,
    paquete: `${p.buy_quantity} de ${names} por ${formatMXN(p.bundle_price)}`,
    porcentaje: `${num(p.percent)}% en ${p.item_ids.length || p.category_ids.length ? names : 'toda la cuenta'}`,
    monto: `${formatMXN(p.amount)} menos en la cuenta`,
    regalo: `${p.reward_quantity || 1} ${reward} gratis por cada ${p.buy_quantity || 1} de ${names}`,
  }[p.kind];
  const when = [
    p.days_of_week.length ? p.days_of_week.map((d) => DAYS[d]).join(' ') : '',
    p.start_time && p.end_time ? `${p.start_time}–${p.end_time}` : '',
    p.starts_on || p.ends_on ? `${p.starts_on || '…'} al ${p.ends_on || '…'}` : '',
    num(p.min_amount) ? `compra mín. ${formatMXN(p.min_amount)}` : '',
    !p.applies_pos ? 'solo en línea' : !p.applies_web ? 'solo en caja' : '',
  ].filter(Boolean).join(' · ');
  return when ? `${what} · ${when}` : what;
}

export default function PromotionsPage() {
  const { me } = useAdmin();
  const [list, setList] = useState<Promotion[] | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ promotions: Promotion[] }>(`/pos/promotions${me.branches[0] ? `?branch_id=${me.branches[0].id}` : ''}`)
      .then((r) => setList(r.promotions)).catch((e) => setError(errorMessage(e)));
  }, [me.branches]);
  useEffect(() => {
    load();
    api<Menu>('/pos/menu').then(setMenu).catch(() => undefined);
  }, [load]);

  if (!posCan.manage(me.user.role)) return <Navigate to="/admin" replace />;

  async function remove(p: Promotion) {
    if (!window.confirm(`¿Borrar "${p.name}"?`)) return;
    try {
      const r = await api<{ archived?: boolean } | undefined>(`/pos/promotions/${p.id}`, { method: 'DELETE' });
      if (r?.archived) window.alert('Ya se aplicó en ventas: se desactivó en lugar de borrarse.');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader title="Promociones" subtitle="Se aplican solas en la caja y en el pedido en línea, según su horario."
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nueva promoción</Button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!list ? <Spinner /> : list.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-400">
          <Gift className="mx-auto mb-3 h-8 w-8 text-gray-600" />
          Sin promociones. Ejemplos: “Martes de 2x1 en tacos”, “3 tacos por $200”, “10% en compras de más de $500”.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((p) => (
            <article key={p.id} className={`card flex gap-3 p-4 ${p.active ? '' : 'opacity-50'}`}>
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
                {p.kind === 'porcentaje' ? <Percent className="h-5 w-5" /> : p.kind === 'regalo' ? <Gift className="h-5 w-5" /> : <Tag className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-white">{p.name}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${!p.active ? 'bg-gray-800 text-gray-400' : p.active_now ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-200'}`}>
                    {!p.active ? 'Inactiva' : p.active_now ? 'Aplicando ahora' : 'Fuera de horario'}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-400">{describe(p, menu)}</p>
              </div>
              <div className="flex flex-shrink-0 gap-1">
                <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(p)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(p)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
              </div>
            </article>
          ))}
        </div>
      )}
      <VouchersSection menu={menu} />
      {editing && menu && (
        <PromotionModal promotion={editing === 'new' ? null : editing} menu={menu} branches={me.branches}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </>
  );
}

function PromotionModal({ promotion: p, menu, branches, onClose, onSaved }: {
  promotion: Promotion | null; menu: Menu; branches: { id: string; name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: p?.name || '', kind: p?.kind || ('nxm' as PromotionKind),
    item_ids: p?.item_ids || [], category_ids: p?.category_ids || [],
    buy_quantity: String(p?.buy_quantity ?? 2), pay_quantity: String(p?.pay_quantity ?? 1),
    percent: p?.percent != null ? String(num(p.percent)) : '', amount: p?.amount != null ? String(num(p.amount)) : '',
    bundle_price: p?.bundle_price != null ? String(num(p.bundle_price)) : '',
    reward_item_id: p?.reward_item_id || '', reward_quantity: String(p?.reward_quantity ?? 1),
    same_modifiers: p?.same_modifiers ?? false, min_amount: p ? String(num(p.min_amount)) : '0',
    applies_pos: p?.applies_pos ?? true, applies_web: p?.applies_web ?? true, branch_ids: p?.branch_ids || [],
    starts_on: p?.starts_on || '', ends_on: p?.ends_on || '', days_of_week: p?.days_of_week || [],
    start_time: p?.start_time || '', end_time: p?.end_time || '', priority: String(p?.priority ?? 0), active: p?.active ?? true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toggle = <K extends 'item_ids' | 'category_ids' | 'branch_ids'>(k: K, id: string) =>
    setF((x) => ({ ...x, [k]: x[k].includes(id) ? x[k].filter((v) => v !== id) : [...x[k], id] }));
  const usesProducts = f.kind !== 'monto';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const n = (v: string) => (v === '' ? null : Number(v));
    try {
      await api(p ? `/pos/promotions/${p.id}` : '/pos/promotions', {
        method: p ? 'PATCH' : 'POST',
        body: {
          ...f,
          item_ids: usesProducts ? f.item_ids : [], category_ids: usesProducts ? f.category_ids : [],
          buy_quantity: ['nxm', 'paquete', 'regalo'].includes(f.kind) ? n(f.buy_quantity) : null,
          pay_quantity: f.kind === 'nxm' ? n(f.pay_quantity) : null,
          percent: f.kind === 'porcentaje' ? n(f.percent) : null,
          amount: f.kind === 'monto' ? n(f.amount) : null,
          bundle_price: f.kind === 'paquete' ? n(f.bundle_price) : null,
          reward_item_id: f.kind === 'regalo' ? f.reward_item_id || null : null,
          reward_quantity: f.kind === 'regalo' ? n(f.reward_quantity) : null,
          min_amount: Number(f.min_amount) || 0, priority: Number(f.priority) || 0,
          starts_on: f.starts_on || null, ends_on: f.ends_on || null,
          start_time: f.start_time || null, end_time: f.end_time || null,
        },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const chip = (on: boolean) => `rounded-lg border px-2.5 py-1 text-sm ${on ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-400'}`;
  return (
    <Modal title={p ? 'Editar promoción' : 'Nueva promoción'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre"><input className="input" required maxLength={80} value={f.name} placeholder="Ej. Martes de 2x1" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Tipo">
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as PromotionKind })}>
              {(Object.keys(KIND_LABEL) as PromotionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {f.kind === 'nxm' && <>
            <Field label="Lleva"><input className="input" type="number" min="2" max="100" required value={f.buy_quantity} onChange={(e) => setF({ ...f, buy_quantity: e.target.value })} /></Field>
            <Field label="Paga"><input className="input" type="number" min="0" max="99" required value={f.pay_quantity} onChange={(e) => setF({ ...f, pay_quantity: e.target.value })} /></Field>
          </>}
          {f.kind === 'paquete' && <>
            <Field label="Piezas"><input className="input" type="number" min="1" max="100" required value={f.buy_quantity} onChange={(e) => setF({ ...f, buy_quantity: e.target.value })} /></Field>
            <Field label="Precio del paquete"><input className="input" type="number" min="0" step="0.01" required value={f.bundle_price} onChange={(e) => setF({ ...f, bundle_price: e.target.value })} /></Field>
          </>}
          {f.kind === 'porcentaje' && <Field label="Descuento (%)"><input className="input" type="number" min="0" max="100" step="0.01" required value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field>}
          {f.kind === 'monto' && <Field label="Descuento ($)"><input className="input" type="number" min="0" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>}
          {f.kind === 'regalo' && <>
            <Field label="Por cada (piezas)"><input className="input" type="number" min="1" max="100" required value={f.buy_quantity} onChange={(e) => setF({ ...f, buy_quantity: e.target.value })} /></Field>
            <Field label="Regalo">
              <select className="input" required value={f.reward_item_id} onChange={(e) => setF({ ...f, reward_item_id: e.target.value })}>
                <option value="">Elige…</option>
                {menu.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
            <Field label="Cantidad de regalo"><input className="input" type="number" min="1" max="100" value={f.reward_quantity} onChange={(e) => setF({ ...f, reward_quantity: e.target.value })} /></Field>
          </>}
          <Field label="Compra mínima ($)" hint="0 = sin mínimo"><input className="input" type="number" min="0" step="0.01" value={f.min_amount} onChange={(e) => setF({ ...f, min_amount: e.target.value })} /></Field>
        </div>

        {usesProducts && (
          <div>
            <span className="label">
              {f.kind === 'porcentaje' ? 'En qué productos (sin elegir nada = toda la cuenta)' : f.kind === 'regalo' ? 'Al comprar' : 'Productos que cuentan (sin elegir nada = todo el menú)'}
            </span>
            <p className="mb-1.5 text-xs text-gray-500">Categorías</p>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {menu.categories.map((c) => <button key={c.id} type="button" className={chip(f.category_ids.includes(c.id))} onClick={() => toggle('category_ids', c.id)}>{c.name}</button>)}
            </div>
            <p className="mb-1.5 text-xs text-gray-500">Productos</p>
            <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
              {menu.items.map((i) => <button key={i.id} type="button" className={chip(f.item_ids.includes(i.id))} onClick={() => toggle('item_ids', i.id)}>{i.name}</button>)}
            </div>
            {(f.kind === 'nxm' || f.kind === 'paquete') && (
              <label className="mt-2 flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" className="h-4 w-4" checked={f.same_modifiers} onChange={(e) => setF({ ...f, same_modifiers: e.target.checked })} />
                Solo piezas idénticas (mismo producto y opciones)
              </label>
            )}
          </div>
        )}

        <div className="rounded-xl border border-gray-800 p-3">
          <span className="label">Cuándo aplica</span>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => (
              <button key={d} type="button" className={chip(f.days_of_week.includes(i))}
                onClick={() => setF({ ...f, days_of_week: f.days_of_week.includes(i) ? f.days_of_week.filter((x) => x !== i) : [...f.days_of_week, i] })}>{d}</button>
            ))}
            <span className="self-center text-xs text-gray-500">{f.days_of_week.length ? '' : 'Todos los días'}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Desde (hora)"><input className="input" type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></Field>
            <Field label="Hasta (hora)"><input className="input" type="time" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} /></Field>
            <Field label="Inicia el"><input className="input" type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
            <Field label="Termina el"><input className="input" type="date" value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
          </div>
          {branches.length > 1 && (
            <div className="mt-2">
              <p className="mb-1.5 text-xs text-gray-500">Sucursales (sin elegir = todas)</p>
              <div className="flex flex-wrap gap-1.5">
                {branches.map((b) => <button key={b.id} type="button" className={chip(f.branch_ids.includes(b.id))} onClick={() => toggle('branch_ids', b.id)}>{b.name}</button>)}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-gray-300">
          <label className="flex items-center gap-2"><Toggle label="En caja" checked={f.applies_pos} onChange={(v) => setF({ ...f, applies_pos: v })} /> En caja</label>
          <label className="flex items-center gap-2"><Toggle label="En línea" checked={f.applies_web} onChange={(v) => setF({ ...f, applies_web: v })} /> En línea</label>
          <label className="flex items-center gap-2"><Toggle label="Activa" checked={f.active} onChange={(v) => setF({ ...f, active: v })} /> Activa</label>
          <label className="flex items-center gap-2">Prioridad <input className="input w-20 py-1.5" type="number" min="0" max="1000" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></label>
        </div>
        <p className="text-xs text-gray-500">Si dos promociones tocan el mismo producto, se aplica primero la de menor prioridad; cada pieza recibe un solo descuento.</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
