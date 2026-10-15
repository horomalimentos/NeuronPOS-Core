import { Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { nativeInfo } from '../lib/native';

/**
 * Dentro de una app Android ya instalada (POS, KDS, Nayo Restaurante o Nayo
 * Repartidor): si hay un APK mas nuevo publicado por deploy/instaladores.sh
 * (/api/descargas/android/latest-<modo>.json), avisa arriba con boton para
 * instalarlo. "Despues" lo oculta solo hasta que se vuelva a abrir la app.
 */
const HIDE_KEY = 'npc_app_update_hidden';

type Latest = { versionName?: string; url?: string };

/** "1.0.124" > "1.0.99" */
function isNewer(latest: string, current: string) {
  const a = latest.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export default function AppUpdateBanner() {
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const [hidden, setHidden] = useState(() => {
    try { return sessionStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (hidden) return undefined;
    let cancelled = false;
    void (async () => {
      const info = await nativeInfo();
      if (!info || info.platform !== 'android' || !info.mode || !info.version) return;
      const latest: Latest | null = await fetch(`/api/descargas/android/latest-${info.mode}.json`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (cancelled || !latest?.versionName || !latest.url || !/^https:\/\//.test(latest.url)) return;
      if (isNewer(latest.versionName, info.version)) setUpdate({ version: latest.versionName, url: latest.url });
    })();
    return () => { cancelled = true; };
  }, [hidden]);

  if (!update || hidden) return null;
  const later = () => {
    try { sessionStorage.setItem(HIDE_KEY, '1'); } catch { /* sin almacenamiento */ }
    setHidden(true);
  };
  return (
    <div className="fixed inset-x-0 top-0 z-[1400] flex items-center gap-3 bg-amber-400 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-sm font-medium text-gray-950 shadow-lg" role="alert">
      <Download className="h-5 w-5 shrink-0" />
      <span className="flex-1">Hay una versión nueva de la app ({update.version}).</span>
      <a href={update.url} className="rounded-full bg-gray-950 px-4 py-1.5 font-semibold text-white">Instalar</a>
      <button type="button" onClick={later} aria-label="Después" className="rounded-full p-1 hover:bg-black/10"><X className="h-5 w-5" /></button>
    </div>
  );
}
