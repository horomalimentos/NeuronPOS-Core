import { ClipboardCheck, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay } from '../lib/format';
import { useInv } from './context';
import { COUNT_STATUS_LABEL } from './lib';
import type { InvArea, InvCount } from './types';

/** Conteos fisicos de la sucursal: los abiertos para continuar y el historial. */
export default function CountsPage() {
  const { branchId } = useInv();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<InvCount[] | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    api<{ counts: InvCount[] }>(`/inventory/counts?branch_id=${branchId}`).then((r) => setCounts(r.counts)).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(() => { setCounts(null); load(); }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!counts) return <Spinner />;
  const open = counts.filter((c) => c.status === 'en_progreso' || c.status === 'pausado');
  const closed = counts.filter((c) => !open.includes(c));

  return (
    <>
      <PageHeader
        title="Conteos"
        subtitle="Cuenta lo que hay por área. Al terminar, la existencia queda en lo contado y la diferencia se registra."
        actions={<Button onClick={() => setStarting(true)}><Play className="h-4 w-4" /> Empezar conteo</Button>}
      />
      {open.length > 0 && (
        <div className="mb-6 space-y-2">
          {open.map((c) => (
            <Link key={c.id} to={`/admin/inventario/conteos/${c.id}`} className="card flex items-center justify-between gap-3 p-4 hover:border-brand">
              <span className="flex items-center gap-3">
                <ClipboardCheck className="h-5 w-5 text-brand" />
                <span>
                  <span className="font-medium text-white">{c.area_name || 'Todas las áreas'} · {formatDay(c.count_date)}</span>
                  <span className="block text-xs text-gray-500">{COUNT_STATUS_LABEL[c.status]} · {c.counted_items} capturados · {c.created_by_name}</span>
                </span>
              </span>
              <span className="text-sm text-brand">Continuar</span>
            </Link>
          ))}
        </div>
      )}
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">Historial</h2>
      {closed.length === 0 ? <p className="text-sm text-gray-500">Todavía no hay conteos terminados.</p> : (
        <div className="card divide-y divide-gray-800/70">
          {closed.map((c) => (
            <Link key={c.id} to={`/admin/inventario/conteos/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-900/60">
              <span>
                <span className="text-white">{c.area_name || 'Todas las áreas'} · {formatDay(c.count_date)}</span>
                <span className="block text-xs text-gray-500">{c.counted_items} insumos · {c.completed_by_name || c.created_by_name}</span>
              </span>
              <span className={`text-xs ${c.status === 'completado' ? 'text-emerald-300' : 'text-gray-500'}`}>{COUNT_STATUS_LABEL[c.status]}</span>
            </Link>
          ))}
        </div>
      )}
      {starting && <StartModal branchId={branchId} onClose={() => setStarting(false)} onStarted={(id) => navigate(`/admin/inventario/conteos/${id}`)} />}
    </>
  );
}

function StartModal({ branchId, onClose, onStarted }: { branchId: string; onClose: () => void; onStarted: (id: string) => void }) {
  const [areas, setAreas] = useState<InvArea[] | null>(null);
  const [areaId, setAreaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ areas: InvArea[] }>('/inventory/areas').then((r) => setAreas(r.areas)).catch((e) => setError(errorMessage(e)));
  }, []);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ count: InvCount }>('/inventory/counts', { method: 'POST', body: { branch_id: branchId, area_id: areaId || null } });
      onStarted(r.count.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Empezar conteo" onClose={onClose}>
      {!areas && !error ? <Spinner /> : (
        <div className="space-y-4">
          <Field label="Área" hint="Solo aparecen los insumos de esa área que tocan contar hoy.">
            <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">Todas las áreas</option>
              {(areas || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button onClick={start} loading={busy}>Empezar</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
