// Apps instalables de Nayo (PWA): cliente, restaurante y repartidor. Cada
// pantalla pone su manifest (nombre, icono, start_url y scope propios), asi
// Chrome las instala como tres apps distintas. Tambien guarda el aviso de
// "instalar" de Chrome y borra el globito del icono al abrir la app.
import { useEffect, useSyncExternalStore } from 'react';
import { onNayoHost } from '../marketplace/nayoUrl';

export type NayoApp = 'cliente' | 'restaurante' | 'repartidor';

/** Que app de Nayo es esta pantalla (null: NeuronPOS, sin manifest). */
export function nayoAppFor(pathname: string): NayoApp | null {
  if (pathname === '/repartidor' || pathname.startsWith('/repartidor/')) return 'repartidor';
  if (pathname.startsWith('/admin/delivery')) return 'restaurante';
  if (onNayoHost()) return 'cliente';
  if (/^\/(nayo|delivery)(\/|$)/.test(pathname)) return 'cliente';
  return null;
}

function manifestFor(app: NayoApp) {
  if (app === 'cliente') return onNayoHost() ? '/nayo.webmanifest' : '/nayo-np.webmanifest';
  return `/nayo-${app}.webmanifest`;
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
    const app = nayoAppFor(pathname);
    setLink('manifest', app ? manifestFor(app) : null);
    setLink('apple-touch-icon', app ? `/icons/nayo-${app}-apple.png` : DEFAULT_TOUCH_ICON);
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
