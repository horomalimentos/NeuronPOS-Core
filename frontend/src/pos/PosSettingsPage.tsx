import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAdmin } from '../restaurant/context';
import { EDITABLE_METHOD_KINDS, METHOD_KIND_LABEL, num, posCan } from './lib';
import type { MethodKind, PaymentMethod, PosSettings } from './types';

/** Configuracion del POS: impuesto, descuentos, ticket y metodos de pago. */
export default function PosSettingsPage() {
  const { me } = useAdmin();
  const [settings, setSettings] = useState<PosSettings | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | 'new' | null>(null);

  const load = useCallback(() => {
    api<{ settings: PosSettings }>('/pos/settings').then((r) => setSettings(r.settings)).catch((e) => setError(errorMessage(e)));
    api<{ payment_methods: PaymentMethod[] }>('/pos/payment-methods').then((r) => setMethods(r.payment_methods)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (!posCan.manage(me.user.role)) return <Navigate to="/admin" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError('');
    setOk('');
    try {
      const r = await api<{ settings: PosSettings }>('/pos/settings', {
        method: 'PATCH',
        body: {
          tax_rate_pct: num(settings.tax_rate_pct),
          prices_include_tax: settings.prices_include_tax,
          cashier_max_discount_pct: num(settings.cashier_max_discount_pct),
          ticket_header: settings.ticket_header || null,
          ticket_footer: settings.ticket_footer || null,
        },
      });
      setSettings(r.settings);
      setOk('Configuración guardada. Aplica a las órdenes nuevas.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(m: PaymentMethod) {
    if (!window.confirm(`¿Borrar "${m.name}"?`)) return;
    try {
      const r = await api<{ archived?: boolean } | undefined>(`/pos/payment-methods/${m.id}`, { method: 'DELETE' });
      if (r?.archived) window.alert('Ya tiene pagos registrados: se desactivó en lugar de borrarse.');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader title="Ajustes del POS" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {ok && <div className="mb-4"><Alert kind="success">{ok}</Alert></div>}
      {!settings ? <Spinner /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <form onSubmit={submit} className="card space-y-4 p-5">
            <h2 className="font-semibold text-white">Impuestos, descuentos y ticket</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="IVA (%)"><input className="input" type="number" min="0" max="100" step="0.01" value={String(settings.tax_rate_pct)} onChange={(e) => setSettings({ ...settings, tax_rate_pct: e.target.value })} /></Field>
              <Field label="Descuento máx. cajero (%)" hint="0 = el cajero no da descuentos">
                <input className="input" type="number" min="0" max="100" step="0.01" value={String(settings.cashier_max_discount_pct)} onChange={(e) => setSettings({ ...settings, cashier_max_discount_pct: e.target.value })} />
              </Field>
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-300">
              <Toggle label="Precios con IVA incluido" checked={settings.prices_include_tax} onChange={(v) => setSettings({ ...settings, prices_include_tax: v })} />
              Los precios del menú ya incluyen IVA
            </div>
            <Field label="Encabezado del ticket" hint="RFC, razón social, etc. (opcional)"><textarea className="input" rows={2} maxLength={500} value={settings.ticket_header || ''} onChange={(e) => setSettings({ ...settings, ticket_header: e.target.value })} /></Field>
            <Field label="Pie del ticket"><textarea className="input" rows={2} maxLength={500} value={settings.ticket_footer || ''} onChange={(e) => setSettings({ ...settings, ticket_footer: e.target.value })} placeholder="¡Gracias por su visita!" /></Field>
            <p className="text-xs text-gray-500">Admin y gerente pueden dar cualquier descuento; los meseros no pueden.</p>
            <div className="flex justify-end"><Button type="submit" loading={saving}>Guardar</Button></div>
          </form>

          <section className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-white">Métodos de pago</h2>
              <Button variant="secondary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Agregar</Button>
            </div>
            <ul className="divide-y divide-gray-800">
              {methods.map((m) => (
                <li key={m.id} className={`flex items-center gap-3 py-2.5 ${m.active ? '' : 'opacity-50'}`}>
                  <span className="flex-1 text-gray-200">{m.name}<span className="block text-xs text-gray-500">{METHOD_KIND_LABEL[m.kind]}{!m.active && ' · inactivo'}</span></span>
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(m)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                  <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(m)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-gray-500">El tipo “Efectivo” permite dar cambio y cuenta para el efectivo esperado en el corte.</p>
          </section>
        </div>
      )}
      {editing && (
        <MethodModal method={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </>
  );
}

function MethodModal({ method, onClose, onSaved }: { method: PaymentMethod | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: method?.name || '', kind: method?.kind || ('otro' as MethodKind), active: method?.active ?? true });
  // "Clip en línea" lo usa el pago en línea del portal: solo se renombra.
  const online = method?.kind === 'en_linea' || method?.kind === 'puntos' || method?.kind === 'monedero';
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = online ? { name: form.name, active: form.active } : form;
      await api(method ? `/pos/payment-methods/${method.id}` : '/pos/payment-methods', { method: method ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={method ? 'Editar método de pago' : 'Nuevo método de pago'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Vales" /></Field>
        <Field label="Tipo">
          {online ? (
            <p className="text-sm text-gray-400">
              {method?.kind === 'puntos'
                ? `${METHOD_KIND_LABEL.puntos}: lo registra el canje de puntos en caja; en el corte no se cuenta.`
                : method?.kind === 'monedero'
                  ? `${METHOD_KIND_LABEL.monedero}: lo registra el cobro con monedero; en el corte no se cuenta.`
                  : `${METHOD_KIND_LABEL.en_linea}: lo registra el pago en línea del portal y no entra al corte de caja.`}
            </p>
          ) : (
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as MethodKind })}>
              {EDITABLE_METHOD_KINDS.map((k) => <option key={k} value={k}>{METHOD_KIND_LABEL[k]}</option>)}
            </select>
          )}
        </Field>
        <div className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Activo" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Activo
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
