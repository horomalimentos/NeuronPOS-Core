import { ArrowLeft, ExternalLink, Pause, Play, Receipt, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, StatusBadge, Toggle } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatDate, formatDay, formatMXN, toDateInput } from '../lib/format';
import InvoicesTable from './InvoicesTable';
import { moduleIcon } from '../lib/modules';
import type { RestaurantDetail, RestaurantModule } from '../lib/types';

export default function RestaurantDetailPage() {
  const { id } = useParams();
  const [detail, setDetail] = useState<RestaurantDetail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    platformApi<RestaurantDetail>(`/platform/restaurants/${id}`).then(setDetail).catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  /** Ejecuta un cambio que regresa el detalle actualizado. */
  const mutate = useCallback(async (path: string, method: string, body?: unknown, okMsg?: string) => {
    setError('');
    setNotice('');
    try {
      const d = await platformApi<RestaurantDetail>(`/platform/restaurants/${id}${path}`, { method, body });
      setDetail(d);
      if (okMsg) setNotice(okMsg);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }, [id]);

  if (!detail) return error ? <Alert>{error}</Alert> : <Spinner />;
  const r = detail.restaurant;

  return (
    <>
      <Link to="/panel" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Restaurantes
      </Link>
      <PageHeader
        title={r.name}
        subtitle={<span className="flex flex-wrap items-center gap-3"><StatusBadge status={r.status} /> {r.custom_domain || r.slug} · {detail.counts.branches} sucursal(es) · {detail.counts.users} usuario(s)</span>}
        actions={r.status === 'suspended' ? (
          <Button onClick={() => mutate('/reactivate', 'POST', undefined, 'Restaurante reactivado')}><Play className="h-4 w-4" /> Reactivar</Button>
        ) : (
          <Button variant="danger" onClick={() => mutate('/suspend', 'POST', undefined, 'Restaurante suspendido')}><Pause className="h-4 w-4" /> Suspender</Button>
        )}
      />
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ModulesCard modules={detail.modules} onSave={(code, body) => mutate(`/modules/${code}`, 'PUT', body)} />
          <InvoicesCard detail={detail} onChanged={(msg) => { setError(''); setNotice(msg); load(); }} onError={setError} />
          <GeneralCard key={r.updated_at} detail={detail} onSave={(body) => mutate('', 'PATCH', body, 'Datos guardados')} />
        </div>
        <div className="space-y-6">
          <ChargeCard detail={detail} />
          <DeliveryCard detail={detail} onSave={(body) => mutate('/delivery', 'PUT', body, 'Domicilios actualizados')} />
          <DangerCard slug={r.slug} id={r.id} />
        </div>
      </div>
    </>
  );
}

function ChargeCard({ detail }: { detail: RestaurantDetail }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-medium text-gray-400">Cobro mensual</h2>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-white">{formatMXN(detail.monthly.total_mxn)}</div>
      <ul className="mt-4 space-y-1.5 text-sm">
        {detail.monthly.lines.length === 0 && <li className="text-gray-500">Sin módulos contratados.</li>}
        {detail.monthly.lines.map((l) => (
          <li key={l.module_code} className="flex justify-between text-gray-300">
            <span>{l.name}</span><span className="tabular-nums">{formatMXN(l.amount_mxn)}</span>
          </li>
        ))}
      </ul>
      {detail.restaurant.status === 'suspended' && (
        <p className="mt-3 text-xs text-amber-300">
          {detail.restaurant.suspended_reason === 'falta_pago'
            ? 'Suspendido por falta de pago: se reactiva solo al pagar.'
            : 'Suspendido manualmente: no se generan cobros mientras siga así.'}
        </p>
      )}
      <p className="mt-3 text-xs text-gray-500">
        Día de cobro: {detail.restaurant.billing_day || (detail.restaurant.activated_at ? `${new Date(detail.restaurant.activated_at).getDate()} (alta)` : 'al activarse')}
        {detail.restaurant.dunning_grace_until && ` · sin suspensión automática hasta ${formatDay(detail.restaurant.dunning_grace_until)}`}
      </p>
    </section>
  );
}

function InvoicesCard({ detail, onChanged, onError }: {
  detail: RestaurantDetail; onChanged: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function generate() {
    setBusy(true);
    try {
      const r = await platformApi<{ created: boolean; link_error: string | null }>(
        `/platform/restaurants/${detail.restaurant.id}/invoices`, { method: 'POST' },
      );
      const msg = r.created ? 'Cobro generado' : 'El cobro de este periodo ya existía';
      onChanged(r.link_error ? `${msg}, pero no se pudo crear la liga de Clip: ${r.link_error}` : msg);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 px-5 py-4">
        <div>
          <h2 className="font-semibold text-white">Facturas</h2>
          <p className="text-xs text-gray-500">Se generan solas cada día de cobro con su liga de pago de Clip.</p>
        </div>
        <Button variant="secondary" loading={busy} onClick={generate}><Receipt className="h-4 w-4" /> Generar cobro ahora</Button>
      </div>
      <InvoicesTable invoices={detail.invoices} onChanged={onChanged} />
    </section>
  );
}

function ModulesCard({ modules, onSave }: {
  modules: RestaurantModule[];
  onSave: (code: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <section className="card">
      <div className="border-b border-gray-800 px-5 py-4">
        <h2 className="font-semibold text-white">Módulos</h2>
        <p className="text-xs text-gray-500">Deja el precio personalizado vacío para usar el precio de catálogo.</p>
      </div>
      <ul className="divide-y divide-gray-800">
        {/* La key incluye los valores guardados: al cambiar se reinicia el formulario de la fila. */}
        {modules.map((m) => (
          <ModuleRow key={`${m.module_code}:${m.custom_price_mxn}:${m.discount_pct}:${m.enabled}`} m={m} onSave={onSave} />
        ))}
      </ul>
    </section>
  );
}

function ModuleRow({ m, onSave }: { m: RestaurantModule; onSave: (code: string, body: Record<string, unknown>) => Promise<boolean> }) {
  const Icon = moduleIcon(m.module_code);
  const savedPrice = m.custom_price_mxn === null ? '' : String(Number(m.custom_price_mxn));
  const [price, setPrice] = useState(savedPrice);
  const [discount, setDiscount] = useState(String(Number(m.discount_pct)));
  const [busy, setBusy] = useState(false);
  const dirty = (price === '' ? '' : String(Number(price))) !== savedPrice || Number(discount) !== Number(m.discount_pct);

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    await onSave(m.module_code, body);
    setBusy(false);
  };

  const expired = m.enabled && !m.is_active;
  return (
    <li className="flex flex-wrap items-center gap-4 px-5 py-4">
      <div className={`rounded-xl p-2.5 ${m.is_active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-[10rem] flex-1">
        <div className="font-medium text-white">{m.name}</div>
        <div className="text-xs text-gray-500">
          Catálogo {formatMXN(m.monthly_price_mxn)}
          {m.started_at && ` · desde ${formatDate(m.started_at)}`}
          {m.ends_at && ` · hasta ${formatDate(m.ends_at)}`}
          {expired && <span className="text-amber-300"> · vencido</span>}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <label className="w-28">
          <span className="text-[11px] text-gray-500">Precio especial</span>
          <input className="input py-1.5" type="number" min="0" step="0.01" placeholder="—" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="w-20">
          <span className="text-[11px] text-gray-500">Desc. %</span>
          <input className="input py-1.5" type="number" min="0" max="100" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </label>
        {dirty && (
          <Button variant="secondary" className="py-1.5" loading={busy}
            onClick={() => run({ custom_price_mxn: price === '' ? null : Number(price), discount_pct: Number(discount || 0) })}>
            Guardar
          </Button>
        )}
      </div>
      <Toggle label={`Habilitar ${m.name}`} checked={m.enabled} disabled={busy} onChange={(v) => run({ enabled: v })} />
    </li>
  );
}

function GeneralCard({ detail, onSave }: { detail: RestaurantDetail; onSave: (body: Record<string, unknown>) => Promise<boolean> }) {
  const r = detail.restaurant;
  const initial = () => ({
    name: r.name, slug: r.slug, custom_domain: r.custom_domain || '', logo_url: r.logo_url || '',
    primary_color: r.primary_color, secondary_color: r.secondary_color, status: r.status,
    trial_ends_at: toDateInput(r.trial_ends_at), contact_name: r.contact_name || '',
    contact_email: r.contact_email || '', contact_phone: r.contact_phone || '', notes: r.notes || '',
    billing_day: r.billing_day ? String(r.billing_day) : '',
  });
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  const set = (k: keyof ReturnType<typeof initial>) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    await onSave({
      ...form,
      custom_domain: form.custom_domain || null,
      logo_url: form.logo_url || null,
      trial_ends_at: form.trial_ends_at ? `${form.trial_ends_at}T23:59:59` : null,
      billing_day: form.billing_day ? Number(form.billing_day) : null,
    });
    setSaving(false);
  }

  return (
    <section className="card">
      <div className="border-b border-gray-800 px-5 py-4"><h2 className="font-semibold text-white">Datos y marca</h2></div>
      <form onSubmit={submit} className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Nombre"><input className="input" required value={form.name} onChange={set('name')} /></Field>
        <Field label="Slug"><input className="input" required value={form.slug} onChange={set('slug')} /></Field>
        <Field label="Dominio propio" hint="Opcional, ej. www.mirestaurante.com">
          <input className="input" value={form.custom_domain} onChange={set('custom_domain')} />
        </Field>
        <Field label="URL del logo"><input className="input" type="url" value={form.logo_url} onChange={set('logo_url')} /></Field>
        <Field label="Color principal">
          <div className="flex gap-2">
            <input type="color" className="h-10 w-12 cursor-pointer rounded-lg border border-gray-700 bg-gray-800" value={form.primary_color} onChange={set('primary_color')} />
            <input className="input" value={form.primary_color} onChange={set('primary_color')} />
          </div>
        </Field>
        <Field label="Color secundario">
          <div className="flex gap-2">
            <input type="color" className="h-10 w-12 cursor-pointer rounded-lg border border-gray-700 bg-gray-800" value={form.secondary_color} onChange={set('secondary_color')} />
            <input className="input" value={form.secondary_color} onChange={set('secondary_color')} />
          </div>
        </Field>
        <Field label="Estado">
          <select className="input" value={form.status} onChange={set('status')}>
            <option value="active">Activo</option>
            <option value="trial">Prueba</option>
            <option value="suspended">Suspendido</option>
          </select>
        </Field>
        <Field label="Fin de la prueba"><input className="input" type="date" value={form.trial_ends_at} onChange={set('trial_ends_at')} /></Field>
        <Field label="Contacto"><input className="input" value={form.contact_name} onChange={set('contact_name')} /></Field>
        <Field label="Teléfono"><input className="input" value={form.contact_phone} onChange={set('contact_phone')} /></Field>
        <Field label="Correo de contacto"><input className="input" type="email" value={form.contact_email} onChange={set('contact_email')} /></Field>
        <Field label="Notas internas"><input className="input" value={form.notes} onChange={set('notes')} /></Field>
        <Field label="Día de cobro" hint="1 a 31. Vacío = el día en que se activó. En meses cortos se cobra el último día.">
          <input className="input" type="number" min={1} max={31} value={form.billing_day} onChange={set('billing_day')} />
        </Field>
        <div className="flex items-center justify-between sm:col-span-2">
          <a href={`/?restaurante=${r.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
            Ver sitio <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <Button type="submit" loading={saving}>Guardar cambios</Button>
        </div>
      </form>
    </section>
  );
}

function DeliveryCard({ detail, onSave }: { detail: RestaurantDetail; onSave: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [mode, setMode] = useState(detail.delivery.mode);
  const [feeType, setFeeType] = useState(detail.delivery.horom_fee_type);
  const [feeValue, setFeeValue] = useState(String(Number(detail.delivery.horom_fee_value)));
  const [saving, setSaving] = useState(false);
  const enabled = detail.modules.find((m) => m.module_code === 'domicilios')?.is_active;

  return (
    <section className="card p-5">
      <h2 className="font-semibold text-white">Domicilios</h2>
      {!enabled && <p className="mt-1 text-xs text-amber-300">El módulo de domicilios no está habilitado.</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {(['propio', 'horom'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            className={`rounded-xl border px-3 py-2 text-sm transition ${mode === m ? 'border-brand bg-brand/15 text-white' : 'border-gray-700 text-gray-400 hover:text-white'}`}>
            {m === 'propio' ? 'Repartidores propios' : 'Repartidores Horom'}
          </button>
        ))}
      </div>
      {mode === 'horom' && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Comisión">
            <select className="input" value={feeType} onChange={(e) => setFeeType(e.target.value as 'fixed' | 'percent')}>
              <option value="fixed">Fija por pedido ($)</option>
              <option value="percent">Porcentaje (%)</option>
            </select>
          </Field>
          <Field label={feeType === 'percent' ? 'Porcentaje' : 'Monto MXN'}>
            <input className="input" type="number" min="0" max={feeType === 'percent' ? 100 : undefined} step="0.01" value={feeValue} onChange={(e) => setFeeValue(e.target.value)} />
          </Field>
        </div>
      )}
      <Button className="mt-4 w-full" variant="secondary" loading={saving} onClick={async () => {
        setSaving(true);
        await onSave({ mode, horom_fee_type: feeType, horom_fee_value: Number(feeValue || 0) });
        setSaving(false);
      }}>Guardar domicilios</Button>
    </section>
  );
}

function DangerCard({ slug, id }: { slug: string; id: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  return (
    <section className="card border-red-900/60 p-5">
      <h2 className="font-semibold text-red-300">Zona peligrosa</h2>
      <p className="mt-1 text-xs text-gray-500">Borra el restaurante con sus sucursales y usuarios. No se puede deshacer.</p>
      <Button variant="danger" className="mt-4 w-full" onClick={() => setOpen(true)}><Trash2 className="h-4 w-4" /> Borrar restaurante</Button>
      {open && (
        <Modal title="Borrar restaurante" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            {error && <Alert>{error}</Alert>}
            <p className="text-sm text-gray-300">Escribe <b className="text-white">{slug}</b> para confirmar.</p>
            <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Button variant="danger" className="w-full" disabled={confirm !== slug} onClick={async () => {
              try {
                await platformApi(`/platform/restaurants/${id}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' });
                navigate('/panel', { replace: true });
              } catch (err) {
                setError(errorMessage(err));
              }
            }}>Borrar definitivamente</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
