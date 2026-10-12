import { Check, MonitorSmartphone, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Device } from './DeviceBanner';
import { formatDateTime } from './lib';

const STATUS = { pendiente: ['Por autorizar', 'bg-amber-500/15 text-amber-300'], activo: ['Autorizado', 'bg-emerald-500/15 text-emerald-300'], revocado: ['Dado de baja', 'bg-gray-800 text-gray-400'] } as const;

/** Ajustes del POS: equipos que pueden abrir caja y cobrar (modulo "dispositivos"). */
export default function DevicesCard() {
  const [list, setList] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<{ devices: Device[] }>('/devices').then((r) => setList(r.devices)).catch((e) => setError(errorMessage(e))); }, []);
  useEffect(load, [load]);
  async function act(d: Device, action: 'approve' | 'revoke' | 'delete') {
    if (action !== 'approve' && !confirm(action === 'revoke' ? `¿Dar de baja "${d.name}"? Ya no podrá cobrar.` : `¿Borrar "${d.name}"? Podrá volver a pedir su alta.`)) return;
    try {
      await api(action === 'delete' ? `/devices/${d.id}` : `/devices/${d.id}/${action}`, { method: action === 'delete' ? 'DELETE' : 'POST', body: action === 'delete' ? undefined : {} });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <section className="card p-5 lg:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-white"><MonitorSmartphone className="h-5 w-5 text-brand" /> Dispositivos</h2>
      <p className="mb-4 text-sm text-gray-400">Solo estos equipos pueden abrir caja, cobrar y recargar monederos. Un equipo nuevo pide su alta desde Caja.</p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!list ? null : list.length === 0 ? <p className="text-sm text-gray-500">Ningún equipo ha pedido su alta.</p> : (
        <ul className="divide-y divide-gray-800 text-sm">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-white">{d.name} <span className="text-gray-500">· {d.terminal} · {d.branch_name}</span></p>
                <p className="truncate text-xs text-gray-500">
                  Pidió {d.requested_by_name} {formatDateTime(d.created_at)}{d.last_seen_at && ` · última vez ${formatDateTime(d.last_seen_at)}`}
                  {d.user_agent && ` · ${d.user_agent.replace(/^Mozilla\/5\.0 \(([^)]*)\).*$/, '$1')}`}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
              <div className="flex gap-1">
                {d.status === 'pendiente' && <Button onClick={() => act(d, 'approve')}><Check className="h-4 w-4" /> Autorizar</Button>}
                {d.status === 'activo' && <Button variant="secondary" onClick={() => act(d, 'revoke')}><X className="h-4 w-4" /> Dar de baja</Button>}
                {d.status !== 'activo' && <button className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => act(d, 'delete')} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
