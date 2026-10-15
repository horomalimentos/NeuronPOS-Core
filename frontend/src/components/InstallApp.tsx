import { Download } from 'lucide-react';
import { isIos, isStandalone, promptInstall, useInstallPrompt } from '../lib/pwa';

/**
 * "Instalar app": usa el aviso de instalar de Chrome; en iPhone explica
 * Compartir › Agregar a inicio. No sale si ya se abrio como app.
 */
export default function InstallApp({ label = 'Instalar app', className = '' }: { label?: string; className?: string }) {
  const prompt = useInstallPrompt();
  if (isStandalone()) return null;
  if (!prompt && !isIos()) return null;
  const onClick = () => {
    if (prompt) void promptInstall();
    else window.alert('En iPhone: toca Compartir › "Agregar a inicio". Abre la app desde tu pantalla de inicio y activa los avisos.');
  };
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-contrast hover:bg-brand/90 ${className}`}>
      <Download className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
