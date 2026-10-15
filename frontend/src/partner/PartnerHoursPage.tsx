import { Clock, Pencil } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Branch, BranchHours } from '../lib/types';
import BranchHoursModal from '../restaurant/BranchHoursModal';
import { useAdmin } from '../restaurant/context';
import { weekSchedule } from '../site/hours';

/**
 * Horario de cada sucursal en Nayo Partner: se ve la semana y se edita con
 * el mismo formulario de Sucursales › Horario (los clientes solo pueden
 * pedir dentro de este horario).
 */
export default function PartnerHoursPage() {
  const { me } = useAdmin();
  const branches = me.branches.filter((b) => b.active);
  return (
    <>
      <PageHeader title="Horario" subtitle="Los clientes de Nayo solo pueden pedirte dentro de este horario." />
      <div className="grid gap-4 md:grid-cols-2">
        {branches.map((b) => <BranchWeek key={b.id} branch={b} />)}
      </div>
    </>
  );
}

function BranchWeek({ branch }: { branch: Branch }) {
  const [hours, setHours] = useState<BranchHours[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    api<{ hours: BranchHours[] }>(`/branches/${branch.id}/hours`).then((r) => setHours(r.hours)).catch((e) => setError(errorMessage(e)));
  }, [branch.id]);
  useEffect(load, [load]);

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-white"><Clock className="h-5 w-5 text-brand" /> {branch.name}</h2>
        <Button variant="secondary" className="px-3" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Editar</Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {!hours ? (!error && <Spinner />) : (
        <dl className="divide-y divide-gray-800 text-sm">
          {weekSchedule(hours).map((d) => (
            <div key={d.day} className="flex justify-between py-1.5">
              <dt className="text-gray-400">{d.day}</dt>
              <dd className={d.text === 'Cerrado' ? 'text-gray-500' : 'font-medium text-white'}>{d.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {editing && <BranchHoursModal branch={branch} onClose={() => { setEditing(false); load(); }} />}
    </section>
  );
}
