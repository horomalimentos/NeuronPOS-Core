import { PauseCircle, PlayCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatTime } from './lib';

/**
 * Pausar los pedidos en linea de la sucursal por un rato (cocina saturada, sin
 * repartidor...). El portal la muestra cerrada con el mensaje; la caja sigue vendiendo.
 */
export default function OnlinePause({ branchId, canAct }: { branchId: string; canAct: boolean }) {
  const [state, setState] = useState<{ paused_until: string | null; paused_message: string | null } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<typeof state>(`/pos/online-pause?branch_id=${branchId}`).then(setState).catch(() => {}); }, [branchId]);
  useEffect(load, [load]);
  async function pause(minutes: number) {
    const message = window.prompt('Mensaje para los clientes (opcional):', 'Por el momento no estamos recibiendo pedidos en línea. Vuelve en un rato.');
    if (message === null) return;
    try {
      setState(await api(`/pos/online-pause`, { method: 'PUT', body: { branch_id: branchId, minutes, message: message || null } }));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function resume() {
    try {
      setState(await api(`/pos/online-pause?branch_id=${branchId}`, { method: 'DELETE' }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  if (!state) return null;
  if (state.paused_until) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        <PauseCircle className="h-5 w-5" />
        <span className="flex-1">Pedidos en línea <b>pausados hasta las {formatTime(state.paused_until)}</b>{state.paused_message && ` · “${state.paused_message}”`}</span>
        {canAct && <Button variant="secondary" onClick={resume}><PlayCircle className="h-4 w-4" /> Reanudar</Button>}
      </div>
    );
  }
  if (!canAct) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-400">
      <PauseCircle className="h-4 w-4" /> Pausar pedidos en línea:
      {[15, 30, 60, 120].map((m) => (
        <button key={m} className="rounded-lg bg-gray-800 px-3 py-1.5 text-gray-200 hover:bg-gray-700" onClick={() => pause(m)}>{m < 60 ? `${m} min` : `${m / 60} h`}</button>
      ))}
      {error && <span className="text-red-300">{error}</span>}
    </div>
  );
}
