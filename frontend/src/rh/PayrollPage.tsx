import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { LiveSection } from './PayrollExtras';
import { FREQUENCY_LABEL, PERIOD_STATUS_LABEL, PERIOD_STATUS_STYLE, todayStr } from './lib';
import type { Frequency, PayrollPeriod } from './types';

/** Periodos de nomina (prenomina). */
export default function PayrollPage() {
  const [periods, setPeriods] = useState<PayrollPeriod[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api<{ periods: PayrollPeriod[] }>('/rh/payroll/periods').then((r) => setPeriods(r.periods)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <PageHeader
        title="Nómina"
        subtitle="Genera el periodo, revisa la prenómina, apruébala, págala y ciérrala."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Generar periodo</Button>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <LiveSection />
      {!periods ? <Spinner /> : periods.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-500">Todavía no hay periodos. Genera el primero.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Periodo</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium">Empleados</th>
                <th className="px-4 py-3 font-medium">Pagados / firmados</th>
                <th className="px-4 py-3 text-right font-medium">Neto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {periods.map((p) => (
                <tr key={p.id} className="hover:bg-gray-800/40">
                  <td className="px-4 py-3">
                    <Link to={`/admin/rh/nomina/${p.id}`} className="font-medium text-white hover:underline">{formatDay(p.start_date)} al {formatDay(p.end_date)}</Link>
                    <div className="text-xs text-gray-500">{FREQUENCY_LABEL[p.frequency]}</div>
                  </td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${PERIOD_STATUS_STYLE[p.status]}`}>{PERIOD_STATUS_LABEL[p.status]}</span></td>
                  <td className="px-4 py-3 text-gray-300">{p.employees_count}</td>
                  <td className="px-4 py-3 text-gray-400">{p.paid_count ?? 0} / {p.signed_count ?? 0}</td>
                  <td className="px-4 py-3 text-right font-medium text-white">{formatMXN(p.total_net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <GenerateModal onClose={() => setCreating(false)} />}
    </>
  );
}

function GenerateModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [frequency, setFrequency] = useState<Frequency>('semanal');
  const [date, setDate] = useState(todayStr(-7));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await api<{ period: PayrollPeriod }>('/rh/payroll/periods', { method: 'POST', body: { frequency, date } });
      navigate(`/admin/rh/nomina/${r.period.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Generar periodo de nómina" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Frecuencia" hint="Incluye a los empleados con esa frecuencia de pago.">
          <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            {Object.entries(FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Cualquier día dentro del periodo" hint="La semana empieza el día configurado en Configuración. Si el periodo ya existe se abre el mismo.">
          <input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Generar y calcular</Button>
        </div>
      </form>
    </Modal>
  );
}
