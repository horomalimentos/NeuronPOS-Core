// Apps instalables (PWA): las tres de Nayo (cliente, restaurante y
// repartidor), Nayo Partner (el restaurante administra su ficha y ve sus
// numeros) y Panel (la plataforma). Cada pantalla pone su manifest (nombre,
// icono, start_url y scope propios), asi Chrome las instala como apps
// distintas. Tambien guarda el aviso de "instalar" de Chrome y borra el
// globito del icono al abrir la app.
import { useEffect, useSyncExternalStore } from 'react';
import { onNayoHost } from '../marketplace/nayoUrl';

export type NayoApp = 'cliente' | 'restaurante' | 'repartidor';
export type InstallableApp = NayoApp | 'partner' | 'panel';

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** Que app instalable es esta pantalla (null: NeuronPOS, sin manifest). */
export function appFor(pathname: string): InstallableApp | null {
  if (under(pathname, '/repartidor')) return 'repartidor';
  // Partner y Panel viven en neuronpos.app (y el dominio de cada restaurante).
  if (!onNayoHost() && under(pathname, '/partner')) return 'partner';
  if (!onNayoHost() && under(pathname, '/panel')) return 'panel';
  if (pathname.startsWith('/admin/delivery')) return 'restaurante';
  if (onNayoHost()) return 'cliente';
  if (/^\/(nayo|delivery)(\/|$)/.test(pathname)) return 'cliente';
  return null;
}

/** Manifest e icono de iPhone de cada app. */
function filesFor(app: InstallableApp) {
  if (app === 'panel') return { manifest: '/panel.webmanifest', apple: '/icons/panel-apple.png' };
  if (app === 'partner') return { manifest: '/nayo-partner.webmanifest', apple: '/icons/nayo-partner-apple.png' };
  const manifest = app === 'cliente' ? (onNayoHost() ? '/nayo.webmanifest' : '/nayo-np.webmanifest') : `/nayo-${app}.webmanifest`;
  return { manifest, apple: `/icons/nayo-${app}-apple.png` };
}

function setLink(rel: string, href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!href) { el?.remove(); return; }
  if (!el) { el = document.createElement('link'); el.rel = rel; document.head.appendChild(el); }
  if (el.getAttribute('href') !== href) el.href = href;
}

const DEFAULT_TOUCH_ICON = '/apple-touch-icon.png';

/** Pone el manifest y el icono de iPhone de la app que se esta viendo. */
export function usePwaManifest(pathname: string) {
  useEffect(() => {
    const app = appFor(pathname);
    const files = app ? filesFor(app) : null;
    setLink('manifest', files?.manifest ?? null);
    setLink('apple-touch-icon', files?.apple ?? DEFAULT_TOUCH_ICON);
    if (app && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, [pathname]);
}

// Aviso de instalar de Chrome (Android y escritorio).
interface InstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches
  || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** iPhone/iPad no tienen aviso de instalar: se agrega desde Compartir. */
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

export function useInstallPrompt() {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => deferred,
  );
}

export async function promptInstall() {
  if (!deferred) return false;
  const ev = deferred;
  deferred = null;
  emit();
  await ev.prompt();
  return (await ev.userChoice).outcome === 'accepted';
}

/** Borra el globito del icono (al abrir o volver a la app). */
export function clearAppBadge() {
  const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  nav.clearAppBadge?.().catch(() => {});
  navigator.serviceWorker?.controller?.postMessage({ type: 'clear-badge' });
}

/**
 * Quita el aviso con esa etiqueta (pedido ya atendido). mute: ademas calla sus
 * repeticiones en este telefono (pedido disponible que el repartidor salto).
 */
export function closeNotification(tag: string, mute = false) {
  navigator.serviceWorker?.controller?.postMessage({ type: 'close-tag', tag, mute });
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
  clearAppBadge();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') clearAppBadge(); });
}
