import { ChevronDown, ChevronUp, CreditCard, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { InvoiceBadge } from '../billing/InvoiceBadge';
import { Alert, Button, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { PAID_METHOD_LABEL, formatDate, formatDay, formatMXN } from '../lib/format';
import type { BillingSummary, Invoice, RestaurantStatus } from '../lib/types';
import { useAdmin } from './context';

interface SubscriptionData {
  restaurant: { status: RestaurantStatus; suspended_reason: string | null; trial_ends_at: string | null; billing_day: number | null; next_billing_date: string | null };
  modules: { module_code: string; name: string; amount_mxn: number; catalog_price_mxn: number; custom_price_mxn: number | null; discount_pct: number }[];
  monthly_total_mxn: number;
  invoices: Invoice[];
  summary: BillingSummary;
}

/**
 * Mi suscripcion: modulos contratados, mensualidad y facturas con el boton
 * "Pagar con Clip". Es la unica pantalla disponible si el restaurante esta
 * suspendido. Al regresar de Clip (?factura=&pago=) se verifica el pago con
 * el servidor, que lo concilia con Clip.
 */
export default function SubscriptionPage() {
  const { reload: reloadMe } = useAdmin();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'warning'; text: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const checked = useRef(false);

  const load = useCallback(() => {
    api<SubscriptionData>('/subscription').then((d) => { setData(d); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  // Regreso desde Clip: verificar (con reintentos cortos si Clip aun no confirma).
  useEffect(() => {
    const invoiceId = params.get('factura');
    const result = params.get('pago');
    if (!invoiceId || checked.current) return;
    checked.current = true;
    if (result && result !== 'ok') {
      setNotice({ kind: 'warning', text: result === 'cancelado' ? 'Cancelaste el pago. Puedes intentarlo de nuevo cuando quieras.' : 'Clip no pudo procesar el pago. Intenta de nuevo o con otra tarjeta.' });
    }
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const verify = async () => {
      setVerifying(true);
      try {
        const r = await api<{ invoice: Invoice; restaurant_status: RestaurantStatus }>(`/subscription/invoices/${invoiceId}/verify`, { method: 'POST' });
        if (r.invoice.status === 'paid') {
          setNotice({ kind: 'success', text: r.restaurant_status === 'active' ? '¡Pago recibido! Tu servicio está activo.' : '¡Pago recibido!' });
          setVerifying(false);
          setParams({}, { replace: true });
          load();
          reloadMe();
          return;
        }
        tries += 1;
        if (result === 'ok' && tries < 6) {
          timer = setTimeout(verify, 3000);
          return;
        }
        if (result === 'ok') setNotice({ kind: 'warning', text: 'Clip todavía no confirma tu pago. Se reflejará en unos minutos.' });
      } catch (e) {
        setError(errorMessage(e));
      }
      setVerifying(false);
    };
    void verify();
    return () => clearTimeout(timer);
  }, [params, setParams, load, reloadMe]);

  async function pay(inv: Invoice) {
    setPaying(inv.id);
    setError('');
    try {
      const r = await api<{ payment_url: string }>(`/subscription/invoices/${inv.id}/pay`, { method: 'POST' });
      window.location.assign(r.payment_url);
    } catch (e) {
      setError(errorMessage(e));
      setPaying(null);
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const r = data.restaurant;
  return (
    <>
      <PageHeader
        title="Mi suscripción"
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={r.status} />
          {r.status === 'trial' && r.trial_ends_at && <>Tu prueba termina el {formatDate(r.trial_ends_at)}; ese día se genera tu primer cobro.</>}
          {r.status === 'active' && r.next_billing_date && <>Siguiente cobro: {formatDay(r.next_billing_date)}.</>}
        </span>}
      />
      <div className="mb-4 space-y-2">
        {verifying && <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Confirmando tu pago con Clip…</p>}
        {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
        {error && <Alert>{error}</Alert>}
        {r.status === 'suspended' && (
          <Alert>
            {r.suspended_reason === 'falta_pago'
              ? 'Tu servicio está suspendido por falta de pago. Paga tu factura vencida y se reactiva al instante.'
              : 'Tu servicio está suspendido. Comunícate con NeuronPOS.'}
          </Alert>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card p-5">
          <h2 className="text-sm font-medium text-gray-400">Mensualidad</h2>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-white">{formatMXN(data.monthly_total_mxn)}</div>
          <ul className="mt-4 space-y-2 text-sm">
            {data.modules.length === 0 && <li className="text-gray-500">Sin módulos contratados.</li>}
            {data.modules.map((m) => (
              <li key={m.module_code} className="flex justify-between gap-3 text-gray-300">
                <span>{m.name}{m.discount_pct > 0 && <span className="block text-xs text-emerald-300">{m.discount_pct}% de descuento</span>}</span>
                <span className="tabular-nums">{formatMXN(m.amount_mxn)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-gray-500">
            Se cobra por adelantado cada mes. Si un pago no se cubre {data.summary.grace_days} días después de su fecha límite, el servicio se suspende hasta pagarlo.
          </p>
        </section>

        <section className="card lg:col-span-2">
          <div className="border-b border-gray-800 px-5 py-4"><h2 className="font-semibold text-white">Facturas</h2></div>
          {data.invoices.length === 0 && <p className="px-5 py-8 text-center text-sm text-gray-500">Todavía no tienes facturas.</p>}
          <ul className="divide-y divide-gray-800">
            {data.invoices.map((inv) => <InvoiceRow key={inv.id} inv={inv} paying={paying === inv.id} onPay={() => pay(inv)} />)}
          </ul>
        </section>
      </div>
    </>
  );
}

function InvoiceRow({ inv, paying, onPay }: { inv: Invoice; paying: boolean; onPay: () => void }) {
  const [open, setOpen] = useState(false);
  const unpaid = inv.status === 'pending' || inv.status === 'overdue';
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[12rem] flex-1">
          <div className="font-medium text-white">{formatDay(inv.period)} – {formatDay(inv.period_end)}</div>
          <div className="text-xs text-gray-500">
            {inv.status === 'paid'
              ? `Pagada el ${formatDate(inv.paid_at)}${inv.paid_method ? ` · ${PAID_METHOD_LABEL[inv.paid_method]}` : ''}`
              : `Fecha límite ${formatDay(inv.due_date)}${inv.suspends_on ? ` · se suspende el ${formatDay(inv.suspends_on)}` : ''}`}
          </div>
        </div>
        <InvoiceBadge status={inv.status} />
        <span className="w-28 text-right font-semibold tabular-nums text-white">{formatMXN(inv.amount_mxn)}</span>
        {unpaid && <Button onClick={onPay} loading={paying}><CreditCard className="h-4 w-4" /> Pagar con Clip</Button>}
        <button type="button" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setOpen(!open)} aria-label="Ver desglose">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <table className="mt-3 w-full text-xs text-gray-400">
          <tbody>
            {(inv.items || []).map((it) => (
              <tr key={it.module_code}>
                <td className="py-1">{it.name}</td>
                <td className="py-1 text-right tabular-nums">{formatMXN(it.unit_price_mxn)}</td>
                <td className="py-1 text-right tabular-nums">{Number(it.discount_mxn) > 0 ? `−${formatMXN(it.discount_mxn)}` : ''}</td>
                <td className="py-1 text-right tabular-nums text-gray-200">{formatMXN(it.amount_mxn)}</td>
              </tr>
            ))}
            {Number(inv.discount_mxn) > 0 && (
              <tr className="border-t border-gray-800"><td className="py-1">Subtotal / descuento</td><td className="py-1 text-right">{formatMXN(inv.subtotal_mxn)}</td><td className="py-1 text-right">−{formatMXN(inv.discount_mxn)}</td><td /></tr>
            )}
          </tbody>
        </table>
      )}
    </li>
  );
}
