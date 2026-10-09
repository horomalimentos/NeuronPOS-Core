import { useEffect, useState } from 'react';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { Section, Stat, Table } from '../pos/ReportsPage';
import { useInv } from './context';
import { fmtQty, todayLocal } from './lib';

interface UsageRow {
  id: string; name: string; base_unit: string; unit_cost: number; sold: number; returned: number; waste: number;
  purchased: number; count_diff: number; adjusted: number; sold_cost: number; waste_cost: number; count_diff_cost: number; purchased_cost: number;
}
interface Usage { products: UsageRow[]; totals: { sold_cost: number; waste_cost: number; count_diff_cost: number; purchased_cost: number } }

const shift = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/**
 * Consumo del periodo por insumo: lo que se vendio segun receta, mermas,
 * compras y la diferencia de los conteos (faltantes o sobrantes), con su costo.
 */
export default function UsagePage() {
  const { branchId } = useInv();
  const today = todayLocal();
  const [from, setFrom] = useState(shift(today, -6));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    setError('');
    api<Usage>(`/inventory/usage?branch_id=${branchId}&from=${from}&to=${to}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [branchId, from, to]);

  const csv = () => data && downloadCsv(`consumo_${from}_a_${to}`,
    ['Insumo', 'Unidad', 'Vendido', 'Merma', 'Comprado', 'Diferencia de conteo', 'Costo vendido', 'Costo merma', 'Costo diferencia'],
    data.products.map((p) => [p.name, p.base_unit, p.sold - p.returned, p.waste, p.purchased, p.count_diff, p.sold_cost, p.waste_cost, p.count_diff_cost]));

  return (
    <>
      <PageHeader
        title="Consumo"
        subtitle="Lo que se gastó según las recetas contra mermas y faltantes de los conteos."
        actions={
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-400">
            {[[6, '7 días'], [29, '30 días']].map(([n, label]) => (
              <button key={label} type="button" className="rounded-full bg-gray-800 px-3 py-1 text-gray-300 hover:bg-gray-700"
                onClick={() => { setFrom(shift(today, -Number(n))); setTo(today); }}>{label}</button>
            ))}
            <input className="input w-auto py-1.5" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="Desde" />
            <input className="input w-auto py-1.5" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="Hasta" />
          </div>
        }
      />
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Costo de lo vendido" value={formatMXN(data.totals.sold_cost)} />
            <Stat label="Mermas" value={formatMXN(data.totals.waste_cost)} />
            <Stat label="Diferencia de conteos" value={formatMXN(data.totals.count_diff_cost)}
              extra={<span className="text-xs text-gray-500">Negativo = faltante</span>} />
            <Stat label="Compras recibidas" value={formatMXN(data.totals.purchased_cost)} />
          </div>
          <Section title="Por insumo" onCsv={csv}>
            <Table
              empty="Sin movimientos en este periodo."
              head={['Insumo', 'Vendido', 'Merma', 'Comprado', 'Dif. conteo', 'Costo vendido', 'Costo merma', 'Costo dif.']}
              rows={data.products.map((p) => [
                p.name,
                `${fmtQty(p.sold - p.returned)} ${p.base_unit}`,
                fmtQty(p.waste),
                fmtQty(p.purchased),
                <span key="d" className={p.count_diff < 0 ? 'text-red-300' : ''}>{fmtQty(p.count_diff)}</span>,
                formatMXN(p.sold_cost),
                formatMXN(p.waste_cost),
                <span key="c" className={p.count_diff_cost < 0 ? 'text-red-300' : ''}>{formatMXN(p.count_diff_cost)}</span>,
              ])}
            />
          </Section>
        </>
      )}
    </>
  );
}
