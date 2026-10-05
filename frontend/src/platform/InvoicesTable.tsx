import { CheckCircle2, Copy, ExternalLink, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { InvoiceBadge } from '../billing/InvoiceBadge';
import { Alert, Button, Field, Modal } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { PAID_METHOD_LABEL, formatDate, formatDay, formatMXN } from '../lib/format';
import type { Invoice } from '../lib/types';

/**
 * Facturas de suscripcion en el Panel (todas o de un restaurante): estado,
 * monto, liga de Clip, fecha de pago y acciones "reenviar liga" y "marcar
 * pagado manualmente".
 */
export default function InvoicesTable({ invoices, showRestaurant, onChanged }: {
  invoices: Invoice[]; showRestaurant?: boolean; onChanged: (msg: string) => void;
}) {
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function resend(inv: Invoice) {
    setBusy(inv.id);
    setError('');
    try {
      const r = await platformApi<{ new_link: boolean }>(`/platform/invoices/${inv.id}/resend`, { method: 'POST' });
      onChanged(r.new_link ? 'Se creó una liga nueva y se envió al restaurante' : 'Liga reenviada al restaurante');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (invoices.length === 0) return <p className="px-5 py-8 text-center text-sm text-gray-500">No hay facturas.</p>;
  return (
    <>
      {error && <div className="px-5 pt-4"><Alert>{error}</Alert></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              {showRestaurant && <th className="px-5 py-3">Restaurante</th>}
              <th className="px-5 py-3">Periodo</th>
              <th className="px-5 py-3 text-right">Monto</th>
              <th className="px-5 py-3">Estado</th>
              <th className="px-5 py-3">Pago</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {invoices.map((inv) => {
              const unpaid = inv.status === 'pending' || inv.status === 'overdue';
              return (
                <tr key={inv.id} className="align-top">
                  {showRestaurant && (
                    <td className="px-5 py-3">
                      <Link to={`/panel/restaurantes/${inv.restaurant_id}`} className="font-medium text-white hover:underline">{inv.restaurant_name}</Link>
                      {inv.restaurant_status === 'suspended' && <span className="block text-xs text-red-300">Suspendido</span>}
                    </td>
                  )}
                  <td className="px-5 py-3 text-gray-300">
                    {formatDay(inv.period)} – {formatDay(inv.period_end)}
                    <span className="block text-xs text-gray-500">
                      Límite {formatDay(inv.due_date)}{unpaid && inv.suspends_on && ` · suspende ${formatDay(inv.suspends_on)}`}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-white">
                    {formatMXN(inv.amount_mxn)}
                    {Number(inv.discount_mxn) > 0 && <span className="block text-xs text-gray-500">desc. {formatMXN(inv.discount_mxn)}</span>}
                  </td>
                  <td className="px-5 py-3"><InvoiceBadge status={inv.status} /></td>
                  <td className="px-5 py-3 text-xs text-gray-400">
                    {inv.status === 'paid' ? (
                      <>
                        {formatDate(inv.paid_at)} · {inv.paid_method ? PAID_METHOD_LABEL[inv.paid_method] : ''}
                        {inv.paid_note && <span className="block text-gray-500">{inv.paid_note}</span>}
                        {inv.paid_reference && <span className="block text-gray-600">Ref. {inv.paid_reference}</span>}
                      </>
                    ) : inv.payment_url ? (
                      <span className="flex items-center gap-2">
                        <a href={inv.payment_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline">
                          Liga de Clip <ExternalLink className="h-3 w-3" />
                        </a>
                        <button type="button" aria-label="Copiar liga" className="text-gray-500 hover:text-white"
                          onClick={() => { void navigator.clipboard?.writeText(inv.payment_url || ''); onChanged('Liga copiada'); }}>
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ) : <span>Sin liga vigente</span>}
                    {inv.last_sent_at && unpaid && <span className="block text-gray-600">Enviada {formatDate(inv.last_sent_at)}</span>}
                  </td>
                  <td className="px-5 py-3">
                    {unpaid && (
                      <div className="flex justify-end gap-1.5">
                        <Button variant="secondary" className="px-2.5 py-1.5 text-xs" loading={busy === inv.id} onClick={() => resend(inv)}>
                          <Send className="h-3.5 w-3.5" /> Reenviar liga
                        </Button>
                        <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setPaying(inv)}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Marcar pagado
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {paying && (
        <MarkPaidModal invoice={paying} onClose={() => setPaying(null)}
          onDone={(msg) => { setPaying(null); onChanged(msg); }} />
      )}
    </>
  );
}

function MarkPaidModal({ invoice, onClose, onDone }: { invoice: Invoice; onClose: () => void; onDone: (msg: string) => void }) {
  const [note, setNote] = useState('Transferencia');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await platformApi<{ reactivated: boolean }>(`/platform/invoices/${invoice.id}/mark-paid`, {
        method: 'POST', body: { note: note.trim(), reference: reference.trim() || null },
      });
      onDone(r.reactivated ? 'Pago registrado: el restaurante se reactivó' : 'Pago registrado');
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Marcar pagado manualmente" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-gray-300">
          {invoice.restaurant_name} · {formatDay(invoice.period)} · <b className="text-white">{formatMXN(invoice.amount_mxn)}</b>
        </p>
        <Field label="Nota" hint="Cómo se pagó (transferencia, efectivo, depósito…).">
          <input className="input" required maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="Referencia (opcional)"><input className="input" maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Ej. folio SPEI" /></Field>
        <p className="text-xs text-gray-500">La liga de Clip pendiente deja de cobrarse. Si el restaurante estaba suspendido por falta de pago y ya no debe nada vencido, se reactiva.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Registrar pago</Button>
        </div>
      </form>
    </Modal>
  );
}
