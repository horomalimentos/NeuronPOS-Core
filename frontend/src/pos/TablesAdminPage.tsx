import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAdmin } from '../restaurant/context';
import BranchSelect from './BranchSelect';
import { posCan } from './lib';
import type { DiningTable, Zone } from './types';
import { usePosBranch } from './usePosBranch';

/** Zonas y mesas de cada sucursal. */
export default function TablesAdminPage() {
  const { me } = useAdmin();
  const { branchId, setBranchId, branches } = usePosBranch();
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [error, setError] = useState('');
  const [editTable, setEditTable] = useState<DiningTable | 'new' | null>(null);

  const load = useCallback(() => {
    if (!branchId) return;
    api<{ zones: Zone[]; tables: DiningTable[] }>(`/pos/tables?branch_id=${branchId}`)
      .then((r) => { setZones(r.zones); setTables(r.tables); })
      .catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(load, [load]);

  if (!posCan.manage(me.user.role)) return <Navigate to="/admin" replace />;

  async function call(path: string, method: string, body?: unknown) {
    setError('');
    try {
      const r = await api<{ archived?: boolean } | undefined>(path, { method, body });
      if (r?.archived) window.alert('La mesa tiene órdenes en su historial: se desactivó en lugar de borrarse.');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const addZone = () => {
    const name = window.prompt('Nombre de la zona (ej. Terraza, Salón)');
    if (name?.trim()) call('/pos/zones', 'POST', { branch_id: branchId, name: name.trim(), sort_order: zones?.length || 0 });
  };
  const renameZone = (z: Zone) => {
    const name = window.prompt('Nuevo nombre', z.name);
    if (name?.trim()) call(`/pos/zones/${z.id}`, 'PATCH', { name: name.trim() });
  };

  return (
    <>
      <PageHeader
        title="Mesas"
        subtitle="Zonas y mesas por sucursal. El estado libre/ocupada se toma de las órdenes abiertas."
        actions={<>
          <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
          <Button variant="secondary" onClick={addZone}><Plus className="h-4 w-4" /> Zona</Button>
          <Button onClick={() => setEditTable('new')}><Plus className="h-4 w-4" /> Mesa</Button>
        </>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!zones ? <Spinner /> : (
        <div className="space-y-6">
          {[...zones, null].map((z) => {
            const list = tables.filter((t) => (z ? t.zone_id === z.id : !t.zone_id));
            if (!z && !list.length) return null;
            return (
              <section key={z?.id || 'none'}>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-medium uppercase tracking-wider text-gray-500">{z ? z.name : 'Sin zona'}</h3>
                  {z && <>
                    <button className="rounded p-1 text-gray-500 hover:text-white" onClick={() => renameZone(z)} aria-label="Renombrar zona"><Pencil className="h-3.5 w-3.5" /></button>
                    <button className="rounded p-1 text-gray-500 hover:text-red-300" onClick={() => window.confirm(`¿Borrar la zona "${z.name}"? Sus mesas quedan sin zona.`) && call(`/pos/zones/${z.id}`, 'DELETE')} aria-label="Borrar zona"><Trash2 className="h-3.5 w-3.5" /></button>
                  </>}
                </div>
                {list.length === 0 ? <p className="text-sm text-gray-600">Sin mesas.</p> : (
                  <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                    {list.map((t) => (
                      <div key={t.id} className={`card relative p-3 text-center ${t.active ? '' : 'opacity-50'}`}>
                        <p className="text-lg font-bold text-white">{t.name}</p>
                        <p className="text-xs text-gray-500">{t.capacity} pers.</p>
                        <p className={`mt-1 text-xs font-semibold ${t.status === 'ocupada' ? 'text-brand' : 'text-emerald-400'}`}>{t.status === 'ocupada' ? 'Ocupada' : 'Libre'}</p>
                        <div className="mt-2 flex justify-center gap-1">
                          <button className="rounded p-1 text-gray-400 hover:text-white" onClick={() => setEditTable(t)} aria-label="Editar"><Pencil className="h-3.5 w-3.5" /></button>
                          <button className="rounded p-1 text-gray-400 hover:text-red-300" onClick={() => window.confirm(`¿Borrar la mesa ${t.name}?`) && call(`/pos/tables/${t.id}`, 'DELETE')} aria-label="Borrar"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {zones.length === 0 && tables.length === 0 && <p className="text-sm text-gray-500">Crea zonas (opcional) y mesas para tomar órdenes de comedor.</p>}
        </div>
      )}
      {editTable && zones && (
        <TableModal table={editTable === 'new' ? null : editTable} zones={zones} branchId={branchId}
          onClose={() => setEditTable(null)} onSaved={() => { setEditTable(null); load(); }} />
      )}
    </>
  );
}

function TableModal({ table, zones, branchId, onClose, onSaved }: {
  table: DiningTable | null; zones: Zone[]; branchId: string; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: table?.name || '', capacity: String(table?.capacity ?? 4), zone_id: table?.zone_id || '', active: table?.active ?? true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { name: form.name, capacity: Number(form.capacity) || 1, zone_id: form.zone_id || null, active: form.active };
      await api(table ? `/pos/tables/${table.id}` : '/pos/tables', { method: table ? 'PATCH' : 'POST', body: table ? body : { ...body, branch_id: branchId } });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={table ? 'Editar mesa' : 'Nueva mesa'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Nombre o número"><input className="input" required maxLength={30} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Personas"><input className="input" type="number" min="1" max="100" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></Field>
        </div>
        <Field label="Zona">
          <select className="input" value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}>
            <option value="">Sin zona</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </Field>
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
