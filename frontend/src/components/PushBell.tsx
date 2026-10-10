import { Bell, BellOff, BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported, type PushTarget } from '../lib/push';
import { errorMessage } from '../lib/api';

/** Estado de los avisos en este navegador: null mientras se revisa. */
function usePushState() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupported()) { setOn(false); return; }
    currentSubscription()
      .then((s) => setOn(Boolean(s) && Notification.permission === 'granted'))
      .catch(() => setOn(false));
  }, []);
  return [on, setOn] as const;
}

/**
 * Campana del encabezado (personal y repartidores): activa o apaga los
 * avisos push de esta cuenta en este dispositivo.
 */
export function PushBell({ target, className = '' }: { target: PushTarget; className?: string }) {
  const [on, setOn] = usePushState();
  const [busy, setBusy] = useState(false);
  if (!pushSupported()) {
    if (!needsHomeScreen()) return null;
    return (
      <button type="button" className={`text-gray-500 ${className}`} title="En iPhone agrega esta página a tu pantalla de inicio para recibir avisos"
        onClick={() => window.alert('En iPhone: toca Compartir › "Agregar a inicio", abre la app desde ahí y activa los avisos.')}>
        <BellOff className="h-4 w-4" />
      </button>
    );
  }
  const toggle = async () => {
    setBusy(true);
    try {
      if (on) { await disablePush(target); setOn(false); } else { await enablePush(target); setOn(true); }
    } catch (e) {
      window.alert(errorMessage(e));
    }
    setBusy(false);
  };
  const label = on ? 'Avisos activados en este dispositivo (toca para apagarlos)' : 'Activar avisos de pedidos en este dispositivo';
  const Icon = on ? BellRing : Bell;
  return (
    <button type="button" onClick={() => void toggle()} disabled={busy || on === null} title={label} aria-label={label}
      className={`flex items-center gap-1 text-sm ${on ? 'text-brand' : 'text-gray-400 hover:text-white'} disabled:opacity-50 ${className}`}>
      <Icon className="h-4 w-4" />
    </button>
  );
}
