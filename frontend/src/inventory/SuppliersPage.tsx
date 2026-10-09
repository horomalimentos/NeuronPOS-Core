import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { InvArea, InvSettings, InvSupplier } from './types';

/** Proveedores, areas de almacen y ajustes del inventario. */
export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<InvSupplier[] | null>(null);
  const [areas, setAreas] = useState<InvArea[]>([]);
  const [settings, setSettings] = useState<InvSettings | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<InvSupplier | 'new' | null>(null);
  const [areaName, setAreaName] = useState('');

  const load = useCallback(() => {
    Promise.all([
      api<{ suppliers: InvSupplier[] }>('/inventory/suppliers'),
      api<{ areas: InvArea[] }>('/inventory/areas'),
      api<{ settings: InvSettings }>('/inventory/settings'),
    ]).then(([s, a, st]) => { setSuppliers(s.suppliers); setAreas(a.areas); setSettings(st.settings); })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); load(); } catch (err) { setError(errorMessage(err)); }
  };
  const saveSettings = (patch: Partial<InvSettings>) => call(async () => {
    const r = await api<{ settings: InvSettings }>('/inventory/settings', { method: 'PATCH', body: patch });
    setSettings(r.settings);
  });

  if (!suppliers || !settings) return error ? <Alert>{error}</Alert> : <Spinner />;

  return (
    <>
      <PageHeader title="Proveedores y áreas" actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo proveedor</Button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Proveedores</h2>
          {suppliers.length === 0 ? <div className="card p-6 text-sm text-gray-400">Sin proveedores.</div> : (
            <div className="card divide-y divide-gray-800/70">
              {suppliers.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span>
                    <span className="font-medium text-white">{s.name}</span>
                    <span className="block text-xs text-gray-500">
                      {[s.contact_name, s.phone, s.email, `${s.products} insumos`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <button type="button" className="p-1 text-gray-400 hover:text-white" aria-label={`Editar ${s.name}`} onClick={() => setEditing(s)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Áreas de almacén</h2>
            <div className="card divide-y divide-gray-800/70">
              {areas.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="text-white">{a.name} <span className="text-xs text-gray-500">{a.products} insumos</span></span>
                  <span className="flex gap-1">
                    <button type="button" className="p-1 text-gray-400 hover:text-white" aria-label={`Renombrar ${a.name}`}
                      onClick={() => {
                        const name = window.prompt('Nuevo nombre', a.name);
                        if (name?.trim()) call(() => api(`/inventory/areas/${a.id}`, { method: 'PATCH', body: { name: name.trim() } }));
                      }}><Pencil className="h-4 w-4" /></button>
                    <button type="button" className="p-1 text-gray-400 hover:text-red-300" aria-label={`Borrar ${a.name}`}
                      onClick={() => window.confirm(`¿Borrar el área "${a.name}"? Sus insumos quedan sin área.`)
                        && call(() => api(`/inventory/areas/${a.id}`, { method: 'DELETE' }))}><Trash2 className="h-4 w-4" /></button>
                  </span>
                </div>
              ))}
              <form className="flex gap-2 p-3" onSubmit={(e) => {
                e.preventDefault();
                if (!areaName.trim()) return;
                call(() => api('/inventory/areas', { method: 'POST', body: { name: areaName.trim() } })).then(() => setAreaName(''));
              }}>
                <input className="input" placeholder="Refrigerador, Congelador, Seco…" value={areaName} onChange={(e) => setAreaName(e.target.value)} aria-label="Nueva área" />
                <Button type="submit" variant="secondary">Agregar</Button>
              </form>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Ajustes</h2>
            <div className="card space-y-4 p-4">
              <label className="flex items-center justify-between gap-3 text-sm text-gray-300">
                <span>Descontar insumos al cobrar<span className="block text-xs text-gray-500">Según la receta de cada producto vendido.</span></span>
                <Toggle checked={settings.deduct_on_sale} onChange={(v) => saveSettings({ deduct_on_sale: v })} label="Descontar al cobrar" />
              </label>
              <Field label="Días que debe cubrir un pedido" hint="El pedido sugerido calcula lo necesario para estos días de consumo.">
                <input className="input w-24" type="number" min={1} max={60} defaultValue={settings.order_cover_days}
                  onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n !== settings.order_cover_days) saveSettings({ order_cover_days: n }); }} />
              </Field>
            </div>
          </section>
        </div>
      </div>
      {editing && <SupplierModal supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

function SupplierModal({ supplier, onClose, onSaved }: { supplier: InvSupplier | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: supplier?.name || '', contact_name: supplier?.contact_name || '', phone: supplier?.phone || '',
    email: supplier?.email || '', notes: supplier?.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]));
    try {
      await api(supplier ? `/inventory/suppliers/${supplier.id}` : '/inventory/suppliers', { method: supplier ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!supplier || !window.confirm(`¿Dar de baja a "${supplier.name}"?`)) return;
    try {
      await api(`/inventory/suppliers/${supplier.id}`, { method: 'DELETE' });
      onSaved();
    } catch (err) { setError(errorMessage(err)); }
  };

  return (
    <Modal title={supplier ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre"><input className="input" required maxLength={120} value={f.name} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contacto"><input className="input" maxLength={120} value={f.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="WhatsApp / teléfono"><input className="input" type="tel" maxLength={40} value={f.phone} onChange={set('phone')} /></Field>
        </div>
        <Field label="Correo"><input className="input" type="email" maxLength={200} value={f.email} onChange={set('email')} /></Field>
        <Field label="Notas" hint="Días de entrega, condiciones de pago…"><textarea className="input" maxLength={1000} value={f.notes} onChange={set('notes')} /></Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-between gap-2">
          {supplier ? <Button type="button" variant="ghost" onClick={remove}><Trash2 className="h-4 w-4" /> Dar de baja</Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={busy}>Guardar</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
