import { Play, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, PageHeader, Spinner } from '../components/ui';
import { errorMessage, platformApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import type { Invoice } from '../lib/types';
import InvoicesTable from './InvoicesTable';

type Filter = '' | 'unpaid' | 'overdue' | 'paid';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'unpaid', label: 'Por cobrar' },
  { value: 'overdue', label: 'Vencidas' },
  { value: 'paid', label: 'Pagadas' },
  { value: '', label: 'Todas' },
];

interface Totals { unpaid_mxn: string; overdue_mxn: string; paid_this_month_mxn: string }

/** Cobros de todos los restaurantes (facturas de la suscripcion). */
export default function InvoicesPage() {
  const [filter, setFilter] = useState<Filter>('unpaid');
  const [data, setData] = useState<{ invoices: Invoice[]; totals: Totals } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    platformApi<{ invoices: Invoice[]; totals: Totals }>(`/platform/invoices${filter ? `?status=${filter}` : ''}`)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(errorMessage(e)));
  }, [filter]);
  useEffect(load, [load]);

  async function runNow() {
    setRunning(true);
    setNotice('');
    setError('');
    try {
      const r = await platformApi<{ skipped: boolean; invoices_created: number; restaurants_suspended: number; trials_converted: number }>(
        '/platform/billing/run', { method: 'POST' },
      );
      setNotice(r.skipped ? 'El cobro ya se está ejecutando, intenta en un momento.'
        : `Cobro ejecutado: ${r.invoices_created} factura(s) nueva(s), ${r.trials_converted} prueba(s) terminada(s), ${r.restaurants_suspended} suspensión(es).`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Cobros"
        subtitle="Mensualidades de los restaurantes. Se generan solas cada día de cobro y se pagan con Clip."
        actions={(
          <>
            <Button variant="secondary" onClick={load}><RefreshCw className="h-4 w-4" /> Actualizar</Button>
            <Button onClick={runNow} loading={running}><Play className="h-4 w-4" /> Correr cobro ahora</Button>
          </>
        )}
      />
      <div className="mb-4 space-y-2">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
      </div>
      {data && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Stat label="Por cobrar" value={formatMXN(data.totals.unpaid_mxn)} />
          <Stat label="Vencido" value={formatMXN(data.totals.overdue_mxn)} danger={Number(data.totals.overdue_mxn) > 0} />
          <Stat label="Cobrado este mes" value={formatMXN(data.totals.paid_this_month_mxn)} />
        </div>
      )}
      <section className="card">
        <div className="flex flex-wrap gap-1 border-b border-gray-800 px-5 py-3">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" onClick={() => setFilter(f.value)}
              className={`rounded-lg px-3 py-1.5 text-sm ${filter === f.value ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>
              {f.label}
            </button>
          ))}
        </div>
        {data ? <InvoicesTable invoices={data.invoices} showRestaurant onChanged={(m) => { setNotice(m); load(); }} /> : <Spinner />}
      </section>
    </>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-gray-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${danger ? 'text-red-300' : 'text-white'}`}>{value}</div>
    </div>
  );
}
