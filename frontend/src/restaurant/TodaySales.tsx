import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatMXN } from '../lib/format';
import { Delta, Stat, type Report } from '../pos/ReportsPage';
import type { Me } from '../lib/types';

/** Inicio: ventas de hoy contra ayer y lo mas vendido (admin/gerente con POS). */
export default function TodaySales({ me }: { me: Me }) {
  const [report, setReport] = useState<Report | null>(null);
  const tz = me.branches[0]?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    api<Report>(`/pos/reports/sales?from=${today}&to=${today}`).then(setReport).catch(() => setReport(null));
  }, [tz]);

  if (!report) return null;
  const s = report.summary;
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">Ventas de hoy</h2>
        <Link to="/admin/reportes" className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
          Ver reportes <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Ventas" value={formatMXN(s.total)} extra={<Delta now={s.total} before={report.previous.total} />} />
        <Stat label="Órdenes" value={String(s.orders)} extra={<Delta now={s.orders} before={report.previous.orders} />} />
        <Stat label="Ticket promedio" value={formatMXN(s.average_ticket)} />
        <Stat label="Propinas" value={formatMXN(s.tips)} />
      </div>
      {report.items.length > 0 && (
        <div className="card mt-3 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">Lo más vendido hoy</p>
          <ol className="space-y-1 text-sm">
            {report.items.slice(0, 5).map((i, n) => (
              <li key={i.menu_item_id} className="flex justify-between gap-3 text-gray-200">
                <span><span className="mr-2 text-gray-500">{n + 1}.</span>{i.name}</span>
                <span className="tabular-nums text-gray-400">{i.quantity} · {formatMXN(i.total)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
