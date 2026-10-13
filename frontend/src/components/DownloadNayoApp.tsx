import { Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getNative } from '../lib/native';

/**
 * Al entrar a Nayo Restaurante o Nayo Repartidor desde el navegador (o la app
 * web), ofrece la app instalable: APK en Android y, el restaurante, EXE en
 * Windows. La app suena con su propio tono y sale encima de cualquier otra
 * app cuando hay un pedido sin atender. No sale dentro de la app ni en iPhone.
 * Los enlaces los escribe deploy/instaladores.sh en /api/descargas/index.json.
 */
type Links = { windows?: string | null; android?: string | null };
type Index = { nayorest?: Links; nayorep?: Links };

const HIDE_KEY = 'npc_nayo_app_hidden';
const HIDE_DAYS = 3;

function platform(): 'android' | 'windows' | null {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  return null;
}

function hiddenRecently(app: string) {
  try {
    const at = Number(localStorage.getItem(`${HIDE_KEY}_${app}`));
    return at > 0 && Date.now() - at < HIDE_DAYS * 86400000;
  } catch {
    return false;
  }
}

export default function DownloadNayoApp({ app }: { app: 'restaurante' | 'repartidor' }) {
  const [url, setUrl] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => hiddenRecently(app));
  const where = platform();

  useEffect(() => {
    if (hidden || getNative() || !where || (app === 'repartidor' && where !== 'android')) return;
    let cancelled = false;
    fetch('/api/descargas/index.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((index: Index | null) => {
        const links = app === 'restaurante' ? index?.nayorest : index?.nayorep;
        const link = links?.[where];
        if (!cancelled && link && /^https:\/\//.test(link)) setUrl(link);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [app, hidden, where]);

  if (!url || hidden) return null;
  const hide = () => {
    try { localStorage.setItem(`${HIDE_KEY}_${app}`, String(Date.now())); } catch { /* sin almacenamiento */ }
    setHidden(true);
  };
  const name = app === 'restaurante' ? 'Nayo Restaurante' : 'Nayo Repartidor';
  const what = app === 'restaurante' ? 'cada pedido nuevo' : 'cada pedido disponible';
  return (
    <div className="relative flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm">
      <Download className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1 pr-6">
        <p className="font-semibold">Descarga la app {name}</p>
        <p className="mt-0.5 text-sm">
          Suena con su propio tono y sale encima de cualquier app con {what}, aunque tengas el {where === 'windows' ? 'navegador cerrado' : 'teléfono bloqueado'}.
        </p>
        <a href={url} className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-950 px-4 py-2 text-sm font-semibold text-amber-50 hover:bg-amber-900">
          <Download className="h-4 w-4" /> {where === 'windows' ? 'Descargar para Windows' : 'Descargar para Android'}
        </a>
      </div>
      <button type="button" onClick={hide} aria-label="Ocultar" className="absolute right-2 top-2 rounded-full p-1 text-amber-900/70 hover:bg-amber-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
