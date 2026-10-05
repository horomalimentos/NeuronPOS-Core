import { Bike, Lock, Truck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import type { DeliveryConfig, DeliveryMode, LedgerSummary, Settlement } from './types';

const METHOD_LABEL = { transferencia: 'Transferencia', efectivo: 'Efectivo', otro: 'Otro' } as const;

/**
 * Domicilios: el restaurante elige entre sus propios repartidores o la flota
 * de NeuronPOS (solo si NeuronPOS se la habilitó). Las condiciones de la
 * flota las fija NeuronPOS; aquí solo se consultan, junto con las
 * liquidaciones del efectivo que cobró la flota.
 */
export default function DeliverySettingsPage() {
  const { me } = useAdmin();
  const isAdmin = me.user.role === 'admin';
  const [settings, setSettings] = useState<DeliveryConfig | null>(null);
  const [ledger, setLedger] = useState<{ summary: LedgerSummary; settlements: Settlement[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<DeliveryMode | null>(null);

  const load = useCallback(() => {
    api<{ settings: DeliveryConfig }>('/delivery/settings').then((r) => setSettings(r.settings)).catch((e) => setError(errorMessage(e)));
    api<{ summary: LedgerSummary; settlements: Settlement[] }>('/delivery/horom/ledger').then(setLedger).catch(() => setLedger(null));
  }, []);
  useEffect(load, [load]);

  async function choose(mode: DeliveryMode) {
    setSaving(mode);
    setError('');
    setNotice('');
    try {
      const r = await api<{ settings: DeliveryConfig }>('/delivery/settings', { method: 'PUT', body: { mode } });
      setSettings(r.settings);
      setNotice(mode === 'horom' ? 'Ahora tus pedidos a domicilio los entrega la flota de NeuronPOS.' : 'Ahora usas tus propios repartidores.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  if (!settings) return error ? <Alert>{error}</Alert> : <Spinner />;
  const fee = settings.horom_fee_type === 'percent'
    ? `${Number(settings.horom_fee_value)} % del subtotal de cada pedido entregado`
    : `${formatMXN(settings.horom_fee_value)} por pedido entregado`;

  const options: { mode: DeliveryMode; title: string; text: string; icon: typeof Bike; locked: boolean }[] = [
    {
      mode: 'propio', icon: Bike, locked: false, title: 'Repartidores propios',
      text: 'Tus usuarios con rol Repartidor. La caja elige quién lleva cada pedido; ellos usan la app /repartidor y hacen su corte al terminar.',
    },
    {
      mode: 'horom', icon: Truck, locked: !settings.horom_enabled, title: 'Flota de NeuronPOS',
      text: 'Pides un repartidor para cada pedido. La flota cobra en la puerta y te liquida el efectivo; la comisión se cobra en tu mensualidad o se descuenta en la liquidación.',
    },
  ];

  return (
    <>
      <PageHeader title="Domicilios" subtitle="Quién entrega tus pedidos a domicilio." />
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {options.map((o) => {
          const active = settings.mode === o.mode;
          const Icon = o.icon;
          return (
            <section key={o.mode} className={`card p-5 ${active ? 'border-brand ring-1 ring-brand/40' : ''}`}>
              <div className="flex items-start justify-between">
                <div className={`rounded-xl p-2.5 ${active ? 'bg-brand/15 text-brand' : 'bg-gray-800 text-gray-400'}`}><Icon className="h-6 w-6" /></div>
                {active ? <span className="text-xs font-semibold text-emerald-300">En uso</span> : o.locked && <Lock className="h-4 w-4 text-gray-600" />}
              </div>
              <h2 className="mt-3 font-semibold text-white">{o.title}</h2>
              <p className="mt-1 text-sm text-gray-400">{o.text}</p>
              {o.mode === 'horom' && settings.horom_enabled && settings.horom_fee_type && (
                <p className="mt-3 rounded-xl bg-gray-800/70 px-3 py-2 text-sm text-gray-200">Comisión acordada: <b>{fee}</b></p>
              )}
              {o.locked && <p className="mt-3 text-xs text-gray-500">Para usar la flota comunícate con NeuronPOS: ellos la habilitan y fijan la comisión.</p>}
              {!active && !o.locked && isAdmin && (
                <Button className="mt-4 w-full" variant="secondary" loading={saving === o.mode} onClick={() => choose(o.mode)}>Usar {o.title.toLowerCase()}</Button>
              )}
            </section>
          );
        })}
      </div>
      {!isAdmin && <p className="mt-3 text-xs text-gray-500">Solo un administrador puede cambiar el modo de reparto.</p>}
      <p className="mt-4 text-sm text-gray-400">
        El costo de envío que paga el cliente se configura por sucursal en <Link to="/admin/pedidos-en-linea" className="text-brand underline">Pedidos en línea</Link>.
      </p>

      {ledger && (settings.horom_enabled || ledger.settlements.length > 0) && (
        <>
          <h2 className="mb-3 mt-10 text-sm font-medium uppercase tracking-wider text-gray-500">Liquidaciones de la flota</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Efectivo cobrado por liquidar" value={formatMXN(ledger.summary.cash_pending)} hint={`${ledger.summary.cash_deliveries} entrega(s)`} />
            <Stat label="Comisiones por cobrar" value={formatMXN(ledger.summary.commission_pending)} hint={`${ledger.summary.commission_deliveries} entrega(s)`} />
            <Stat label="Te pagaríamos hoy" value={formatMXN(ledger.summary.payout_now)} hint="Efectivo menos comisiones que quepan" />
          </div>
          <div className="card mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 text-right font-medium">Efectivo</th>
                  <th className="px-4 py-3 text-right font-medium">Comisiones</th>
                  <th className="px-4 py-3 text-right font-medium">Pagado</th>
                  <th className="px-4 py-3 font-medium">Forma</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {ledger.settlements.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3 text-gray-400">{formatDateTime(s.created_at)}<span className="block text-xs">{s.deliveries_count} entrega(s)</span></td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMXN(s.cash_amount)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">-{formatMXN(s.commission_amount)}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">{formatMXN(s.net_amount)}</td>
                    <td className="px-4 py-3 text-gray-400">{METHOD_LABEL[s.method]}{s.reference && ` · ${s.reference}`}</td>
                  </tr>
                ))}
                {ledger.settlements.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Sin liquidaciones todavía.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}
