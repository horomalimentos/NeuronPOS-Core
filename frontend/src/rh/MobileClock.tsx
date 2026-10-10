import { Loader2, MapPin } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../pos/lib';

interface State { enabled: boolean; radius_meters?: number | null; last?: { kind: string; occurred_at: string } | null; next?: 'entrada' | 'salida' }

/**
 * Checada desde el celular (si la sucursal lo permite): pide la ubicacion del
 * telefono y el servidor revisa que este dentro de la geocerca.
 */
export default function MobileClock() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const load = useCallback(() => { api<State>('/rh/me/clock').then(setState).catch(() => setState(null)); }, []);
  useEffect(load, [load]);
  if (!state?.enabled) return null;

  function clock() {
    if (!navigator.geolocation) { setMsg({ kind: 'error', text: 'Este navegador no da la ubicación' }); return; }
    setBusy(true);
    setMsg(null);
    navigator.geolocation.getCurrentPosition(async (p) => {
      try {
        const r = await api<{ entry: { kind: string }; late_minutes: number }>('/rh/me/clock', {
          method: 'POST', body: { latitude: p.coords.latitude, longitude: p.coords.longitude },
        });
        setMsg(r.late_minutes > 0
          ? { kind: 'warning', text: `Entrada registrada con ${r.late_minutes} min de retardo` }
          : { kind: 'success', text: r.entry.kind === 'entrada' ? '¡Entrada registrada!' : '¡Salida registrada!' });
        load();
      } catch (err) {
        setMsg({ kind: 'error', text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    }, () => { setBusy(false); setMsg({ kind: 'error', text: 'Permite el acceso a tu ubicación para checar' }); }, { enableHighAccuracy: true, timeout: 15000 });
  }

  return (
    <section className="card mb-6 flex flex-wrap items-center gap-4 p-5">
      <MapPin className="h-8 w-8 text-brand" />
      <div className="flex-1">
        <h2 className="font-semibold text-white">Checar desde mi celular</h2>
        <p className="text-sm text-gray-400">
          {state.last ? `Última: ${state.last.kind} ${formatDateTime(state.last.occurred_at)}` : 'Sin checadas'} · dentro de {state.radius_meters} m de tu sucursal
        </p>
      </div>
      <Button className="px-6 py-3 text-base" onClick={clock} disabled={busy}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Checar {state.next}
      </Button>
      {msg && <div className="w-full"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
    </section>
  );
}
