import { Award, Trophy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import BranchSelect from '../pos/BranchSelect';
import { usePosBranch } from '../pos/usePosBranch';
import { useAdmin } from '../restaurant/context';
import { MONTH_LABEL } from './lib';
import type { Wall } from './types';

/** Muro del empleado del mes: ganador del ultimo mes y ranking del mes en curso. */
export default function WallPage() {
  const { me } = useAdmin();
  const { branchId, setBranchId, branches } = usePosBranch();
  const [data, setData] = useState<Wall | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<Wall>(`/recognition/wall${branchId ? `?branch_id=${branchId}` : ''}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-white">Empleado del mes · {me.restaurant.name}</h1>
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
      </div>
      <section className="card relative mb-8 overflow-hidden p-8 text-center">
        <div className="absolute inset-x-0 top-0 h-1.5 bg-brand" />
        <Trophy className="mx-auto h-14 w-14 text-amber-300" />
        {data.winners.length === 0 ? (
          <p className="mt-4 text-gray-400">Todavía no hay ganador. ¡El ranking del mes ya está corriendo!</p>
        ) : (
          <>
            <p className="mt-3 text-sm uppercase tracking-widest text-gray-400">
              {data.winners_month && `${MONTH_LABEL[data.winners_month.month - 1]} ${data.winners_month.year}`}
            </p>
            {data.winners.map((w) => (
              <div key={w.employee_id} className="mt-3">
                <div className="text-4xl font-bold text-white">{w.employee_name}</div>
                <div className="mt-1 text-gray-400">{[w.position, w.branch_name].filter(Boolean).join(' · ')} · {Number(w.score).toFixed(1)} puntos</div>
              </div>
            ))}
            {data.prize_text && <p className="mt-4 inline-block rounded-full bg-amber-500/15 px-4 py-1.5 text-sm text-amber-200">Premio: {data.prize_text}</p>}
          </>
        )}
      </section>
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Así va {MONTH_LABEL[data.current.month - 1]}</h2>
      {data.current.ranking.length === 0 ? <p className="text-sm text-gray-500">Sin datos todavía.</p> : (
        <ol className="card divide-y divide-gray-800">
          {data.current.ranking.map((r) => (
            <li key={r.employee_id} className="flex items-center gap-4 px-5 py-3">
              <span className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${r.rank === 1 ? 'bg-amber-400 text-gray-900' : r.rank <= 3 ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400'}`}>{r.rank}</span>
              <div className="flex-1">
                <div className="font-medium text-white">{r.employee_name}{r.rank === 1 && <Award className="ml-1 inline h-4 w-4 text-amber-300" />}</div>
                <div className="text-xs text-gray-500">{[r.position, r.branch_name].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="text-lg font-semibold tabular-nums text-white">{Number(r.score).toFixed(1)}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
