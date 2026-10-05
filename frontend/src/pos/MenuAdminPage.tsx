import { Image as ImageIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import type { Branch } from '../lib/types';
import { useAdmin } from '../restaurant/context';
import { num, posCan } from './lib';
import type { Menu, MenuCategory, MenuItem, ModifierGroup } from './types';

type Tab = 'productos' | 'categorias' | 'modificadores';

/** Administracion del menu: productos, categorias y grupos de modificadores. */
export default function MenuAdminPage() {
  const { me } = useAdmin();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tab, setTab] = useState<Tab>('productos');
  const [error, setError] = useState('');
  const [editItem, setEditItem] = useState<MenuItem | 'new' | null>(null);
  const [editCat, setEditCat] = useState<MenuCategory | 'new' | null>(null);
  const [editGroup, setEditGroup] = useState<ModifierGroup | 'new' | null>(null);

  const load = useCallback(() => {
    api<Menu>('/pos/menu?all=1').then(setMenu).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  if (!posCan.manage(me.user.role)) return <Navigate to="/admin" replace />;

  async function remove(path: string, label: string) {
    if (!window.confirm(`¿Borrar ${label}?`)) return;
    setError('');
    try {
      const r = await api<{ archived?: boolean } | undefined>(path, { method: 'DELETE' });
      if (r?.archived) window.alert('Ya tiene ventas registradas: se desactivó en lugar de borrarse.');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const actions = {
    productos: <Button onClick={() => setEditItem('new')} disabled={!menu?.categories.length}><Plus className="h-4 w-4" /> Nuevo producto</Button>,
    categorias: <Button onClick={() => setEditCat('new')}><Plus className="h-4 w-4" /> Nueva categoría</Button>,
    modificadores: <Button onClick={() => setEditGroup('new')}><Plus className="h-4 w-4" /> Nuevo grupo</Button>,
  }[tab];

  return (
    <>
      <PageHeader title="Menú" subtitle="Productos, categorías y modificadores del punto de venta." actions={actions} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <div className="mb-5 flex gap-1 rounded-xl bg-gray-900 p-1 text-sm">
        {(['productos', 'categorias', 'modificadores'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 rounded-lg px-3 py-2 font-medium capitalize ${tab === t ? 'bg-brand text-brand-contrast' : 'text-gray-400 hover:text-white'}`}>
            {t === 'categorias' ? 'Categorías' : t}
          </button>
        ))}
      </div>

      {!menu ? <Spinner /> : tab === 'productos' ? (
        menu.categories.length === 0 ? <p className="text-sm text-gray-500">Primero crea una categoría.</p> : (
          <div className="space-y-6">
            {menu.categories.map((c) => {
              const list = menu.items.filter((i) => i.category_id === c.id);
              return (
                <section key={c.id}>
                  <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">{c.name}{!c.active && ' (inactiva)'}</h3>
                  {list.length === 0 ? <p className="text-sm text-gray-600">Sin productos.</p> : (
                    <div className="card divide-y divide-gray-800">
                      {list.map((it) => (
                        <div key={it.id} className={`flex items-center gap-3 p-3 ${it.active ? '' : 'opacity-50'}`}>
                          <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-800">
                            {it.image_url ? <img src={it.image_url} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="m-3 h-6 w-6 text-gray-600" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-white">{it.name}</p>
                            <p className="truncate text-xs text-gray-500">
                              {it.modifier_group_ids.map((id) => menu.modifier_groups.find((g) => g.id === id)?.name).filter(Boolean).join(', ') || 'Sin modificadores'}
                              {it.unavailable_branch_ids.length > 0 && ` · no disponible en ${it.unavailable_branch_ids.length} sucursal(es)`}
                            </p>
                          </div>
                          <span className="text-sm text-gray-200">{formatMXN(it.price)}</span>
                          <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditItem(it)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                          <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(`/pos/items/${it.id}`, `"${it.name}"`)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )
      ) : tab === 'categorias' ? (
        <div className="card divide-y divide-gray-800">
          {menu.categories.length === 0 && <p className="p-4 text-sm text-gray-500">Sin categorías.</p>}
          {menu.categories.map((c) => (
            <div key={c.id} className={`flex items-center gap-3 p-3 ${c.active ? '' : 'opacity-50'}`}>
              <div className="flex-1"><p className="font-medium text-white">{c.name}</p>{c.description && <p className="text-xs text-gray-500">{c.description}</p>}</div>
              <span className="text-xs text-gray-500">{menu.items.filter((i) => i.category_id === c.id).length} productos</span>
              <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditCat(c)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
              <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(`/pos/categories/${c.id}`, `la categoría "${c.name}"`)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {menu.modifier_groups.length === 0 && <p className="text-sm text-gray-500">Sin grupos. Ejemplos: “Salsa” (elige 1), “Extras” (hasta 3).</p>}
          {menu.modifier_groups.map((g) => (
            <div key={g.id} className={`card p-4 ${g.active ? '' : 'opacity-50'}`}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-white">{g.name}</h3>
                  <p className="text-xs text-gray-500">{g.min_selections > 0 ? `Obligatorio (mín. ${g.min_selections})` : 'Opcional'}{g.max_selections ? ` · máx. ${g.max_selections}` : ' · sin máximo'}</p>
                </div>
                <div className="flex gap-1">
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditGroup(g)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(`/pos/modifier-groups/${g.id}`, `el grupo "${g.name}"`)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {g.modifiers.map((m) => (
                  <li key={m.id} className="rounded-full bg-gray-800 px-2.5 py-0.5 text-xs text-gray-300">
                    {m.name}{num(m.price_delta) !== 0 && ` ${num(m.price_delta) > 0 ? '+' : ''}${formatMXN(m.price_delta)}`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {editItem && menu && (
        <ItemModal item={editItem === 'new' ? null : editItem} menu={menu} branches={me.branches}
          onClose={() => setEditItem(null)} onSaved={() => { setEditItem(null); load(); }} />
      )}
      {editCat && (
        <CategoryModal category={editCat === 'new' ? null : editCat} onClose={() => setEditCat(null)} onSaved={() => { setEditCat(null); load(); }} />
      )}
      {editGroup && (
        <GroupModal group={editGroup === 'new' ? null : editGroup} onClose={() => setEditGroup(null)} onSaved={() => { setEditGroup(null); load(); }} />
      )}
    </>
  );
}

function useSave(onSaved: () => void) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (path: string, method: string, body: unknown) => {
    setSaving(true);
    setError('');
    try {
      await api(path, { method, body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };
  return { error, saving, save };
}

function ItemModal({ item, menu, branches, onClose, onSaved }: {
  item: MenuItem | null; menu: Menu; branches: Branch[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: item?.name || '', category_id: item?.category_id || menu.categories[0]?.id || '',
    price: item ? String(num(item.price)) : '', description: item?.description || '', image_url: item?.image_url || '',
    active: item?.active ?? true, modifier_group_ids: item?.modifier_group_ids || [],
    unavailable_branch_ids: item?.unavailable_branch_ids || [],
  });
  const { error, saving, save } = useSave(onSaved);
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(item ? `/pos/items/${item.id}` : '/pos/items', item ? 'PATCH' : 'POST', {
      ...form, price: num(form.price), description: form.description || null, image_url: form.image_url || null,
    });
  };

  return (
    <Modal title={item ? 'Editar producto' : 'Nuevo producto'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre"><input className="input" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Precio"><input className="input" required type="number" inputMode="decimal" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
          <Field label="Categoría">
            <select className="input" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
              {menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="URL de la imagen" hint="https://… (opcional)"><input className="input" type="url" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} /></Field>
        </div>
        <Field label="Descripción"><textarea className="input" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        {menu.modifier_groups.length > 0 && (
          <div>
            <span className="label">Modificadores</span>
            <div className="flex flex-wrap gap-2">
              {menu.modifier_groups.map((g) => {
                const on = form.modifier_group_ids.includes(g.id);
                return (
                  <button key={g.id} type="button" onClick={() => setForm({ ...form, modifier_group_ids: toggleIn(form.modifier_group_ids, g.id) })}
                    className={`rounded-lg border px-3 py-1.5 text-sm ${on ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>{g.name}</button>
                );
              })}
            </div>
          </div>
        )}
        {branches.length > 0 && (
          <div>
            <span className="label">Disponible en</span>
            <div className="flex flex-wrap gap-3">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="checkbox" className="h-4 w-4 accent-current" checked={!form.unavailable_branch_ids.includes(b.id)}
                    onChange={() => setForm({ ...form, unavailable_branch_ids: toggleIn(form.unavailable_branch_ids, b.id) })} />
                  {b.name}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Activo" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Activo (se muestra en el POS)
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function CategoryModal({ category, onClose, onSaved }: { category: MenuCategory | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: category?.name || '', description: category?.description || '',
    sort_order: String(category?.sort_order ?? 0), active: category?.active ?? true,
  });
  const { error, saving, save } = useSave(onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(category ? `/pos/categories/${category.id}` : '/pos/categories', category ? 'PATCH' : 'POST', {
      ...form, description: form.description || null, sort_order: Number(form.sort_order) || 0,
    });
  };
  return (
    <Modal title={category ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Descripción"><input className="input" maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Orden" hint="Menor número aparece primero"><input className="input" type="number" min="0" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} /></Field>
        <div className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Activa" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Activa
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

interface ModRow { id?: string; name: string; price_delta: string; active: boolean }

function GroupModal({ group, onClose, onSaved }: { group: ModifierGroup | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: group?.name || '', min_selections: String(group?.min_selections ?? 0),
    max_selections: group?.max_selections == null ? '' : String(group.max_selections), active: group?.active ?? true,
  });
  const [mods, setMods] = useState<ModRow[]>(group?.modifiers.map((m) => ({ id: m.id, name: m.name, price_delta: String(num(m.price_delta)), active: m.active })) || [{ name: '', price_delta: '0', active: true }]);
  const { error, saving, save } = useSave(onSaved);
  const setMod = (i: number, patch: Partial<ModRow>) => setMods((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(group ? `/pos/modifier-groups/${group.id}` : '/pos/modifier-groups', group ? 'PATCH' : 'POST', {
      name: form.name, active: form.active,
      min_selections: Number(form.min_selections) || 0,
      max_selections: form.max_selections === '' ? null : Number(form.max_selections),
      modifiers: mods.filter((m) => m.name.trim()).map((m) => ({ id: m.id, name: m.name, price_delta: num(m.price_delta), active: m.active })),
    });
  };

  return (
    <Modal title={group ? 'Editar grupo de modificadores' : 'Nuevo grupo de modificadores'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Nombre"><input className="input" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Salsa" /></Field>
          <Field label="Mínimo" hint="0 = opcional"><input className="input" type="number" min="0" max="50" value={form.min_selections} onChange={(e) => setForm({ ...form, min_selections: e.target.value })} /></Field>
          <Field label="Máximo" hint="Vacío = sin límite"><input className="input" type="number" min="1" max="50" value={form.max_selections} onChange={(e) => setForm({ ...form, max_selections: e.target.value })} /></Field>
        </div>
        <div>
          <span className="label">Opciones (precio: ajuste sobre el producto, puede ser negativo)</span>
          <div className="space-y-2">
            {mods.map((m, i) => (
              <div key={m.id || `n${i}`} className="flex items-center gap-2">
                <input className="input flex-1" maxLength={80} value={m.name} placeholder="Nombre" onChange={(e) => setMod(i, { name: e.target.value })} />
                <input className="input w-28" type="number" step="0.01" value={m.price_delta} onChange={(e) => setMod(i, { price_delta: e.target.value })} aria-label="Ajuste de precio" />
                <Toggle label="Activa" checked={m.active} onChange={(v) => setMod(i, { active: v })} />
                <button type="button" className="rounded-lg p-1.5 text-gray-400 hover:text-red-300" onClick={() => setMods((ms) => ms.filter((_, j) => j !== i))} aria-label="Quitar"><X className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
          <Button type="button" variant="ghost" className="mt-2" onClick={() => setMods((ms) => [...ms, { name: '', price_delta: '0', active: true }])}><Plus className="h-4 w-4" /> Agregar opción</Button>
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Grupo activo" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Grupo activo
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
