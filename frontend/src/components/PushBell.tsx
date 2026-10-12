import { Bell, BellOff, BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { disablePush, enablePush, needsHomeScreen, pushIsOn, pushSupported, type PushTarget } from '../lib/push';
import { errorMessage } from '../lib/api';

/** Estado de los avisos en este navegador: null mientras se revisa. */
function usePushState(target: PushTarget) {
  const [on, setOn] = useState<boolean | null>(null);
  const key = JSON.stringify(target);
  useEffect(() => {
    if (!pushSupported()) { setOn(false); return; }
    pushIsOn(JSON.parse(key) as PushTarget).then(setOn).catch(() => setOn(false));
  }, [key]);
  return [on, setOn] as const;
}

/**
 * Campana del encabezado (personal y repartidores): activa o apaga los
 * avisos push de esta cuenta en este dispositivo.
 */
export function PushBell({ target, className = '', label = false }: {
  target: PushTarget; className?: string;
  /** Con texto: "Activar avisos" mientras esten apagados. */
  label?: boolean;
}) {
  const [on, setOn] = usePushState(target);
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
  const title = on ? 'Avisos activados en este dispositivo (toca para apagarlos)' : 'Activar avisos de pedidos en este dispositivo';
  const Icon = on ? BellRing : Bell;
  if (label && on === false) {
    return (
      <button type="button" onClick={() => void toggle()} disabled={busy} title={title}
        className={`inline-flex items-center gap-1.5 rounded-full border border-brand/60 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/10 disabled:opacity-50 ${className}`}>
        <Bell className="h-3.5 w-3.5" /> Activar avisos
      </button>
    );
  }
  return (
    <button type="button" onClick={() => void toggle()} disabled={busy || on === null} title={title} aria-label={title}
      className={`flex items-center gap-1 text-sm ${on ? 'text-brand' : 'text-gray-400 hover:text-white'} disabled:opacity-50 ${className}`}>
      <Icon className="h-4 w-4" />
    </button>
  );
}
