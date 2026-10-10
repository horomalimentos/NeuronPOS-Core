import { ExternalLink, Save } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import type { PublicBranch } from '../lib/types';
import { openLabel } from '../site/hours';
import ClipPaymentsCard from './ClipPaymentsCard';
import { canManage, useAdmin } from './context';
import { ModuleLocked } from './WebsitePage';

interface OnlineSettings {
  enabled: boolean;
  min_order: string | number;
  prep_time_minutes: number;
  auto_accept: boolean;
  allow_pickup: boolean;
  allow_delivery: boolean;
  order_email_alerts: boolean;
}

interface OnlineBranch extends PublicBranch {
  active: boolean;
  online_enabled: boolean;
  delivery_enabled: boolean;
  delivery_fee: string | number;
}

interface OnlineData {
  settings: OnlineSettings;
  branches: OnlineBranch[];
  modules?: { pos: boolean; domicilios: boolean };
}

/**
 * Pedidos en linea (modulo portal): encender/apagar, pedido minimo, tiempo de
 * preparacion, aceptacion automatica o manual y, por sucursal, si recibe
 * pedidos, si entrega a domicilio y el costo de envio.
 */
export default function OnlineSettingsPage() {
  const { me } = useAdmin();
  const enabled = Boolean(me.modules.find((m) => m.code === 'portal')?.enabled);
  const [data, setData] = useState<OnlineData | null>(null);
  const [form, setForm] = useState<OnlineSettings | null>(null);
  const [fees, setFees] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (d: OnlineData) => {
    setData((prev) => ({ ...d, modules: d.modules ?? prev?.modules }));
    setForm(d.settings);
    setFees(Object.fromEntries(d.branches.map((b) => [b.id, String(Number(b.delivery_fee))])));
  };
  const load = useCallback(() => {
    api<OnlineData>('/online/settings').then(apply).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  if (!canManage(me.user.role)) return <Navigate to="/admin" replace />;
  if (!enabled) return <ModuleLocked name="Portal de clientes" />;
  if (!data || !form) return error ? <Alert>{error}</Alert> : <Spinner />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setOk('');
    try {
      apply(await api<OnlineData>('/online/settings', {
        method: 'PATCH',
        body: {
          enabled: form!.enabled, min_order: Number(form!.min_order || 0), prep_time_minutes: Number(form!.prep_time_minutes),
          auto_accept: form!.auto_accept, allow_pickup: form!.allow_pickup, allow_delivery: form!.allow_delivery,
          order_email_alerts: form!.order_email_alerts,
        },
      }));
      setOk('Configuración guardada.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveBranch(b: OnlineBranch, patch: Partial<Pick<OnlineBranch, 'online_enabled' | 'delivery_enabled'>> & { delivery_fee?: number }) {
    setError('');
    try {
      apply(await api<OnlineData>(`/online/branches/${b.id}`, { method: 'PUT', body: patch }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const mods = data.modules;
  return (
    <>
      <PageHeader title="Pedidos en línea" subtitle="Cómo recibe pedidos tu portal de clientes."
        actions={<a href="/pedir" target="_blank" rel="noopener noreferrer"><Button type="button" variant="secondary"><ExternalLink className="h-4 w-4" /> Ver portal</Button></a>} />
      {mods && !mods.pos && <div className="mb-4"><Alert kind="warning">Los pedidos en línea llegan al punto de venta: necesitas el módulo "Punto de venta" para recibirlos.</Alert></div>}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {ok && <div className="mb-4"><Alert kind="success">{ok}</Alert></div>}

      <form onSubmit={save} className="card space-y-5 p-5">
        <label className="flex items-center gap-3 text-sm font-medium text-white">
          <Toggle label="Recibir pedidos en línea" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
          Recibir pedidos en línea
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Pedido mínimo (MXN)" hint="Sobre el subtotal, sin envío. 0 = sin mínimo.">
            <input className="input" type="number" min={0} step="0.01" value={form.min_order} onChange={(e) => setForm({ ...form, min_order: e.target.value })} />
          </Field>
          <Field label="Tiempo de preparación (min)" hint="Lo que se le muestra al cliente.">
            <input className="input" type="number" min={1} max={600} required value={form.prep_time_minutes} onChange={(e) => setForm({ ...form, prep_time_minutes: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="space-y-3 text-sm text-gray-300">
          <label className="flex items-center gap-3">
            <Toggle label="Aceptar automáticamente" checked={form.auto_accept} onChange={(v) => setForm({ ...form, auto_accept: v })} />
            <span>Aceptar pedidos automáticamente <span className="block text-xs text-gray-500">Si está apagado, el cajero los acepta o rechaza desde Vender → En línea.</span></span>
          </label>
          <label className="flex items-center gap-3">
            <Toggle label="Aviso por correo" checked={form.order_email_alerts} onChange={(v) => setForm({ ...form, order_email_alerts: v })} />
            <span>Avisarme por correo de cada pedido <span className="block text-xs text-gray-500">Llega a los administradores y gerentes activos.</span></span>
          </label>
          <label className="flex items-center gap-3">
            <Toggle label="Recoger en sucursal" checked={form.allow_pickup} onChange={(v) => setForm({ ...form, allow_pickup: v })} /> Para recoger en sucursal
          </label>
          <label className="flex items-center gap-3">
            <Toggle label="A domicilio" checked={form.allow_delivery} onChange={(v) => setForm({ ...form, allow_delivery: v })} disabled={mods ? !mods.domicilios : false} />
            <span>A domicilio {mods && !mods.domicilios && <span className="block text-xs text-amber-300">Requiere el módulo "Domicilios".</span>}</span>
          </label>
        </div>
        <p className="text-xs text-gray-500">Pago al recoger o al recibir (efectivo o tarjeta): se cobra en la caja del punto de venta. Para cobrar en línea, configura Clip abajo.</p>
        <div className="flex justify-end"><Button type="submit" loading={saving}><Save className="h-4 w-4" /> Guardar</Button></div>
      </form>

      <ClipPaymentsCard isAdmin={me.user.role === 'admin'} />

      <h2 className="mb-3 mt-8 text-lg font-semibold text-white">Por sucursal</h2>
      <p className="mb-4 text-sm text-gray-400">Solo se aceptan pedidos con la sucursal abierta. El horario se edita en Sucursales.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {data.branches.map((b) => (
          <div key={b.id} className={`card space-y-3 p-5 ${b.active ? '' : 'opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-white">{b.name}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${b.open_now ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' : 'bg-gray-500/15 text-gray-300 ring-gray-500/30'}`}>{openLabel(b)}</span>
            </div>
            <label className="flex items-center gap-3 text-sm text-gray-300">
              <Toggle label="Recibe pedidos en línea" checked={b.online_enabled} onChange={(v) => saveBranch(b, { online_enabled: v })} /> Recibe pedidos en línea
            </label>
            <label className="flex items-center gap-3 text-sm text-gray-300">
              <Toggle label="Entrega a domicilio" checked={b.delivery_enabled} onChange={(v) => saveBranch(b, { delivery_enabled: v })} /> Entrega a domicilio
            </label>
            <div className="flex items-end gap-2">
              <Field label="Costo de envío (MXN)">
                <input className="input" type="number" min={0} step="0.01" value={fees[b.id] ?? ''} onChange={(e) => setFees({ ...fees, [b.id]: e.target.value })} />
              </Field>
              <Button type="button" variant="secondary" disabled={Number(fees[b.id] || 0) === Number(b.delivery_fee)}
                onClick={() => saveBranch(b, { delivery_fee: Number(fees[b.id] || 0) })}>Guardar</Button>
            </div>
            <p className="text-xs text-gray-500">Actual: {formatMXN(b.delivery_fee)}</p>
          </div>
        ))}
      </div>
    </>
  );
}
