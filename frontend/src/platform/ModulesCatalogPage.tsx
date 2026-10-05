import { useEffect, useState } from 'react';
import { Alert, Button, PageHeader, Spinner, Toggle } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { moduleIcon } from '../lib/modules';
import type { CatalogModule } from '../lib/types';

export default function ModulesCatalogPage() {
  const [modules, setModules] = useState<CatalogModule[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    platformApi<{ modules: CatalogModule[] }>('/platform/modules').then((r) => setModules(r.modules)).catch((e) => setError(errorMessage(e)));
  }, []);

  const replace = (m: CatalogModule) => setModules((ms) => ms?.map((x) => (x.code === m.code ? { ...x, ...m } : x)) ?? null);

  return (
    <>
      <PageHeader title="Módulos y precios" subtitle="Precio mensual de catálogo de cada módulo. Cada restaurante puede tener un precio especial." />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!modules ? <Spinner /> : (
        <div className="space-y-3">
          {modules.map((m) => <ModuleEditor key={m.code} m={m} onSaved={replace} />)}
        </div>
      )}
    </>
  );
}

function ModuleEditor({ m, onSaved }: { m: CatalogModule; onSaved: (m: CatalogModule) => void }) {
  const Icon = moduleIcon(m.code);
  const [form, setForm] = useState({ name: m.name, description: m.description, price: String(Number(m.monthly_price_mxn)), sort: String(m.sort_order) });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const dirty = form.name !== m.name || form.description !== m.description
    || Number(form.price) !== Number(m.monthly_price_mxn) || Number(form.sort) !== m.sort_order;

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await platformApi<{ module: CatalogModule }>(`/platform/modules/${m.code}`, { method: 'PUT', body });
      onSaved(r.module);
      setMsg({ kind: 'success', text: 'Guardado' });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="rounded-xl bg-brand/15 p-2.5 text-brand"><Icon className="h-5 w-5" /></div>
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[1fr_2fr]">
          <label>
            <span className="label">Nombre <span className="font-mono text-xs text-gray-600">({m.code})</span></span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            <span className="label">Descripción</span>
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
        </div>
        <label className="w-36">
          <span className="label">Precio mensual</span>
          <input className="input" type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </label>
        <label className="w-20">
          <span className="label">Orden</span>
          <input className="input" type="number" value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-3 text-gray-400">
          <Toggle label="Disponible para contratar" checked={m.active} disabled={busy} onChange={(v) => save({ active: v })} />
          {m.active ? 'Disponible para contratar' : 'No disponible'}
          <span className="text-gray-600">· {m.enabled_restaurants ?? 0} restaurante(s) · actual {formatMXN(m.monthly_price_mxn)}</span>
        </div>
        <div className="flex items-center gap-3">
          {msg && <span className={msg.kind === 'error' ? 'text-red-300' : 'text-emerald-300'}>{msg.text}</span>}
          <Button disabled={!dirty} loading={busy} onClick={() => save({
            name: form.name, description: form.description, monthly_price_mxn: Number(form.price || 0), sort_order: Number(form.sort || 0),
          })}>Guardar</Button>
        </div>
      </div>
    </div>
  );
}
