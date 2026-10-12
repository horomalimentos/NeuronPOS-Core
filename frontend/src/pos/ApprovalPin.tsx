import { KeyRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * PIN de autorizacion del gerente (como el de Horom): se lo dicta al cajero
 * para descuentos arriba de su limite. Cambia cada 10 minutos.
 */
export default function ApprovalPinButton() {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState<{ pin: string; expires_at: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let timer: number | undefined;
    const load = () => api<{ pin: string; expires_at: string }>('/pos/approval-pin').then((p) => {
      setPin(p);
      timer = window.setTimeout(load, Math.max(1000, new Date(p.expires_at).getTime() - Date.now() + 500));
    }).catch(() => setPin(null));
    load();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearTimeout(timer); window.clearInterval(tick); };
  }, [open]);

  const left = pin ? Math.max(0, Math.round((new Date(pin.expires_at).getTime() - now) / 1000)) : 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center text-gray-400 hover:text-white"
        aria-label="PIN de autorización" title="PIN de autorización para descuentos">
        <KeyRound className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-64 rounded-xl border border-gray-700 bg-gray-900 p-4 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-gray-500">PIN de autorización</p>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white" aria-label="Cerrar"><X className="h-4 w-4" /></button>
          </div>
          <p className="font-mono text-3xl font-bold tracking-[0.3em] text-white">{pin?.pin || '······'}</p>
          <p className="mt-1 text-xs text-gray-400">
            Díctalo al cajero para autorizar un descuento. Cambia en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
          </p>
        </div>
      )}
    </div>
  );
}
