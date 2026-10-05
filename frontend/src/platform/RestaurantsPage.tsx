import { Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatDate, formatMXN } from '../lib/format';
import { moduleIcon } from '../lib/modules';
import type { CatalogModule, RestaurantDetail, RestaurantListItem } from '../lib/types';

interface ListResponse {
  restaurants: RestaurantListItem[];
  monthly_grand_total_mxn: number;
}

export default function RestaurantsPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    platformApi<ListResponse>('/platform/restaurants').then(setData).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.restaurants || []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug.includes(q));
  }, [data, query]);

  const counts = useMemo(() => {
    const c = { active: 0, trial: 0, suspended: 0 };
    data?.restaurants.forEach((r) => { c[r.status] += 1; });
    return c;
  }, [data]);

  return (
    <>
      <PageHeader
        title="Restaurantes"
        subtitle="Cada restaurante paga la suma de los módulos que tiene contratados."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo restaurante</Button>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      {data && (
        <div className="mb-6 grid gap-4 sm:grid-cols-4">
          <Stat label="Ingreso mensual (sin suspendidos)" value={formatMXN(data.monthly_grand_total_mxn)} />
          <Stat label="Activos" value={String(counts.active)} />
          <Stat label="En prueba" value={String(counts.trial)} />
          <Stat label="Suspendidos" value={String(counts.suspended)} />
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="border-b border-gray-800 p-4">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input className="input pl-9" placeholder="Buscar por nombre o slug" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        {!data ? <Spinner /> : filtered.length === 0 ? (
          <p className="p-10 text-center text-sm text-gray-500">
            {data.restaurants.length === 0 ? 'Aún no hay restaurantes. Crea el primero.' : 'Sin resultados.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Restaurante</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Módulos</th>
                  <th className="px-4 py-3 font-medium">Sucursales</th>
                  <th className="px-4 py-3 text-right font-medium">Mensualidad</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-800/40">
                    <td className="px-4 py-3">
                      <Link to={`/panel/restaurantes/${r.id}`} className="flex items-center gap-3">
                        <span className="h-8 w-8 flex-shrink-0 rounded-lg ring-1 ring-white/10" style={{ background: r.primary_color }} />
                        <span>
                          <span className="block font-medium text-white hover:underline">{r.name}</span>
                          <span className="block text-xs text-gray-500">{r.custom_domain || r.slug}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                      {r.status === 'trial' && r.trial_ends_at && (
                        <span className="mt-1 block text-xs text-gray-500">hasta {formatDate(r.trial_ends_at)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        {r.enabled_modules.length === 0 && <span className="text-xs text-gray-600">Ninguno</span>}
                        {r.enabled_modules.map((code) => {
                          const Icon = moduleIcon(code);
                          return <span key={code} title={code} className="rounded-md bg-gray-800 p-1.5 text-gray-300"><Icon className="h-3.5 w-3.5" /></span>;
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400">{r.branch_count}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">{formatMXN(r.monthly_total_mxn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && <CreateRestaurantModal onClose={() => setCreating(false)} />}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
    </div>
  );
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

function CreateRestaurantModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<CatalogModule[]>([]);
  const [form, setForm] = useState({
    name: '', slug: '', status: 'trial', branch_name: 'Matriz',
    admin_name: '', admin_email: '', admin_password: '',
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [modules, setModules] = useState<string[]>(['pos']);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    platformApi<{ modules: CatalogModule[] }>('/platform/modules').then((r) => setCatalog(r.modules)).catch(() => {});
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [k]: value, ...(k === 'name' && !slugTouched ? { slug: slugify(value) } : {}) }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const withAdmin = form.admin_email.trim() !== '';
      const res = await platformApi<RestaurantDetail>('/platform/restaurants', {
        method: 'POST',
        body: {
          name: form.name, slug: form.slug, status: form.status, branch_name: form.branch_name, modules,
          admin: withAdmin ? { name: form.admin_name || form.admin_email, email: form.admin_email, password: form.admin_password } : undefined,
        },
      });
      navigate(`/panel/restaurantes/${res.restaurant.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title="Nuevo restaurante" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre"><input className="input" required value={form.name} onChange={set('name')} /></Field>
          <Field label="Slug (subdominio)" hint={`${form.slug || 'slug'}.tudominio`}>
            <input
              className="input" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" value={form.slug}
              onChange={(e) => { setSlugTouched(true); set('slug')(e); }}
            />
          </Field>
          <Field label="Estado">
            <select className="input" value={form.status} onChange={set('status')}>
              <option value="trial">Prueba</option>
              <option value="active">Activo</option>
            </select>
          </Field>
          <Field label="Primera sucursal"><input className="input" value={form.branch_name} onChange={set('branch_name')} /></Field>
        </div>

        <div>
          <span className="label">Módulos contratados</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.map((m) => {
              const Icon = moduleIcon(m.code);
              const checked = modules.includes(m.code);
              return (
                <label key={m.code} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition
                  ${checked ? 'border-brand/60 bg-brand/10' : 'border-gray-800 hover:border-gray-700'}`}>
                  <input
                    type="checkbox" className="accent-[rgb(var(--brand-primary))]" checked={checked}
                    onChange={() => setModules((ms) => (checked ? ms.filter((c) => c !== m.code) : [...ms, m.code]))}
                  />
                  <Icon className="h-4 w-4 text-gray-400" />
                  <span className="flex-1">{m.name}</span>
                  <span className="text-xs text-gray-500">{formatMXN(m.monthly_price_mxn)}</span>
                </label>
              );
            })}
          </div>
        </div>

        <fieldset className="rounded-xl border border-gray-800 p-4">
          <legend className="px-2 text-sm text-gray-400">Administrador del restaurante (opcional)</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Nombre"><input className="input" value={form.admin_name} onChange={set('admin_name')} /></Field>
            <Field label="Correo"><input className="input" type="email" value={form.admin_email} onChange={set('admin_email')} /></Field>
            <Field label="Contraseña">
              <input className="input" type="password" minLength={8} required={form.admin_email !== ''} value={form.admin_password} onChange={set('admin_password')} />
            </Field>
          </div>
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Crear restaurante</Button>
        </div>
      </form>
    </Modal>
  );
}
