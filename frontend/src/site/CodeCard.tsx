import { KeyRound, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, portalApi } from '../lib/api';

interface Code { code: string; expires_at: string; seconds_left: number }
interface PosCode { needed: boolean; code_locked?: boolean; code?: Code | null }

/**
 * Codigo de 6 digitos que el cliente dicta en caja para pagar con puntos o
 * con su monedero. Cambia cada 5 minutos; tras 5 errores se bloquea y el
 * cliente genera uno nuevo.
 */
export default function CodeCard() {
  const [data, setData] = useState<PosCode | null>(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(0);

  const load = useCallback(() => {
    portalApi<PosCode>('/portal/me/pos-code').then((r) => { setData(r); setLeft(r.code?.seconds_left || 0); })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  // Cuenta regresiva; al vencer se pide el codigo nuevo.
  useEffect(() => {
    if (!data?.code) return undefined;
    const t = setInterval(() => setLeft((s) => {
      if (s <= 1) { load(); return 0; }
      return s - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [data?.code, load]);

  const reset = async () => {
    try {
      const r = await portalApi<{ code: Code }>('/portal/me/pos-code/reset', { method: 'POST' });
      setData({ needed: true, code: r.code, code_locked: false });
      setLeft(r.code.seconds_left);
    } catch (e) { setError(errorMessage(e)); }
  };

  if (error || !data?.needed) return null;
  return (
    <section className="card-light rounded-2xl p-4 text-center">
      {data.code_locked ? (
        <>
          <p className="text-sm text-gray-600">Tu código se bloqueó por intentos equivocados.</p>
          <button type="button" className="btn-brand mt-3" onClick={reset}><RefreshCw className="h-4 w-4" /> Generar código nuevo</button>
        </>
      ) : data.code && (
        <>
          <p className="flex items-center justify-center gap-1 text-xs uppercase tracking-wider text-gray-500"><KeyRound className="h-3.5 w-3.5" /> Código para pagar en caja</p>
          <p className="my-1 font-mono text-4xl font-bold tracking-[0.3em] text-gray-900">{data.code.code}</p>
          <p className="text-xs text-gray-500">Cambia en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · díselo solo a quien te cobra</p>
        </>
      )}
    </section>
  );
}
