import { Bell, BellOff, BellRing, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { disablePush, enablePush, needsHomeScreen, pushIsOn, pushSupported, type PushTarget } from '../lib/push';
import { errorMessage } from '../lib/api';

/** Se avisa al activar o apagar, para que la campanita y el boton flotante cambien juntos. */
const PUSH_EVENT = 'npc-push-change';

/** Estado de los avisos en este navegador: null mientras se revisa. */
function usePushState(target: PushTarget) {
  const [on, setOnState] = useState<boolean | null>(null);
  const key = JSON.stringify(target);
  useEffect(() => {
    if (!pushSupported()) { setOnState(false); return undefined; }
    const check = () => { pushIsOn(JSON.parse(key) as PushTarget).then(setOnState).catch(() => setOnState(false)); };
    check();
    window.addEventListener(PUSH_EVENT, check);
    return () => window.removeEventListener(PUSH_EVENT, check);
  }, [key]);
  const setOn = (v: boolean) => { setOnState(v); window.dispatchEvent(new Event(PUSH_EVENT)); };
  return [on, setOn] as const;
}

const IPHONE_HELP = 'En iPhone: toca Compartir › "Agregar a inicio", abre la app desde ahí y activa los avisos.';

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
        onClick={() => window.alert(IPHONE_HELP)}>
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

/**
 * Boton flotante "Activa tus avisos": aparece mientras los avisos esten
 * apagados en este dispositivo y se va solo al activarlos. Con la X se
 * esconde hasta la proxima vez que abras la app.
 */
export function PushFab({ target, className = 'bottom-24 right-4', text = 'Activa tus avisos' }: {
  target: PushTarget;
  /** Donde va en la pantalla (para no tapar lo de cada app). */
  className?: string;
  text?: string;
}) {
  const [on, setOn] = usePushState(target);
  const [busy, setBusy] = useState(false);
  const hideKey = `npc_push_fab_${JSON.stringify(target)}`;
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(hideKey) === '1'; } catch { return false; } });
  const iphone = !pushSupported() && needsHomeScreen();
  if (hidden || on !== false || (!pushSupported() && !iphone)) return null;

  const activate = async () => {
    if (iphone) { window.alert(IPHONE_HELP); return; }
    setBusy(true);
    try {
      await enablePush(target);
      setOn(true);
    } catch (e) {
      window.alert(Notification.permission === 'denied'
        ? 'Los avisos están bloqueados para este sitio. Actívalos en los ajustes del navegador (el candado junto a la dirección) y vuelve a intentar.'
        : errorMessage(e));
    }
    setBusy(false);
  };
  const hide = () => { setHidden(true); try { sessionStorage.setItem(hideKey, '1'); } catch { /* sin almacenamiento */ } };
  return (
    <div className={`fixed z-[800] flex items-center gap-1 rounded-full bg-brand py-1 pl-1 pr-1 text-brand-contrast shadow-2xl shadow-black/60 ${className}`}>
      <button type="button" onClick={() => void activate()} disabled={busy}
        className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-2 text-sm font-bold disabled:opacity-60">
        <span className="relative flex h-6 w-6 items-center justify-center">
          <span className="absolute h-full w-full animate-ping rounded-full bg-white/40" />
          <BellRing className="relative h-4 w-4" />
        </span>
        {busy ? 'Activando…' : text}
      </button>
      <button type="button" onClick={hide} aria-label="Ahora no" title="Ahora no" className="rounded-full p-1.5 opacity-70 hover:bg-black/10 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
