import { Clock, MonitorSmartphone } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { meHas, useAdmin } from '../restaurant/context';

export interface Device {
  id: string; branch_id: string; branch_name: string; name: string; terminal: string; status: 'pendiente' | 'activo' | 'revocado';
  user_agent: string | null; last_seen_at: string | null; created_at: string; requested_by_name: string | null; reviewed_by_name: string | null; reviewed_at: string | null;
}

/**
 * Control de dispositivos (modulo "dispositivos"): si este equipo no esta
 * autorizado para la caja, lo dice y deja pedir el alta. Si ya lo esta, no muestra nada.
 */
export default function DeviceBanner({ branchId, onActive }: { branchId: string; onActive?: (d: Device) => void }) {
  const { me } = useAdmin();
  const enabled = meHas(me, 'dispositivos');
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [terminal, setTerminal] = useState('Caja 1');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    api<{ device: Device | null }>('/devices/me').then((r) => {
      setDevice(r.device);
      // La caja del equipo autorizado manda (el turno se abre con ese nombre).
      if (r.device?.status === 'activo') onActive?.(r.device);
    }).catch(() => setDevice(null));
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled || device === undefined || device?.status === 'activo') return null;

  async function request(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      setDevice((await api<{ device: Device }>('/devices/request', { method: 'POST', body: { name, terminal, branch_id: branchId } })).device);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
      {device?.status === 'pendiente' ? (
        <p className="flex items-center gap-2"><Clock className="h-4 w-4" /> <b>{device.name}</b> espera que un gerente lo autorice en Ajustes &gt; Dispositivos. Mientras, este equipo puede tomar órdenes pero no cobrar.</p>
      ) : device?.status === 'revocado' ? (
        <p className="flex items-center gap-2"><MonitorSmartphone className="h-4 w-4" /> Este equipo fue dado de baja para la caja. Pide al gerente que lo borre para volver a pedir el alta.</p>
      ) : (
        <form onSubmit={request} className="space-y-3">
          <p className="flex items-center gap-2 font-semibold"><MonitorSmartphone className="h-4 w-4" /> Este equipo no está autorizado para abrir caja ni cobrar</p>
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Nombre del equipo"><input className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Tablet barra" /></Field>
            <Field label="Caja"><input className="input" required maxLength={40} value={terminal} onChange={(e) => setTerminal(e.target.value)} /></Field>
            <div className="flex items-end"><Button type="submit" loading={saving} className="w-full">Pedir autorización</Button></div>
          </div>
        </form>
      )}
    </div>
  );
}
