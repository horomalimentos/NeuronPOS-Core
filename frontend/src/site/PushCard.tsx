import { BellRing, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/api';
import { currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported } from '../lib/push';
import { hasModule, useSiteCtx } from './context';
import { Notice } from './OrderPage';

const flagKey = (token?: string) => (token ? `np-push-pedido-${token}` : 'np-push-cuenta');
const readFlag = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const writeFlag = (k: string, on: boolean) => { try { if (on) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch { /* sin almacenamiento */ } };

/**
 * Avisos push para el cliente (modulo 'push'). Con token: solo ese pedido
 * (o la cuenta, si el pedido es del cliente con sesion). Sin token, en
 * "Mi cuenta": todos sus pedidos.
 */
export default function PushCard({ token }: { token?: string }) {
  const { site } = useSiteCtx();
  const key = flagKey(token);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pushSupported()) return;
    currentSubscription()
      .then((s) => setOn(Boolean(s) && Notification.permission === 'granted' && readFlag(key)))
      .catch(() => {});
  }, [key]);
  if (!hasModule(site, 'push')) return null;
  const supported = pushSupported();
  if (!supported && !needsHomeScreen()) return null;

  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      if (on) await disablePush({ realm: 'customer', token });
      else await enablePush({ realm: 'customer', token });
      writeFlag(key, !on);
      setOn(!on);
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <div className="card-light flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
        <div>
          <p className="font-semibold">{token ? 'Avísame de mi pedido' : 'Avisos de mis pedidos'}</p>
          <p className="text-sm text-gray-500">
            {!supported
              ? 'En iPhone: toca Compartir › "Agregar a inicio", abre el sitio desde ahí y activa los avisos.'
              : on
                ? 'Te avisamos en este celular cuando lo acepten, esté listo o vaya en camino.'
                : 'Recibe un aviso en este celular cuando lo acepten, esté listo o vaya en camino, aunque cierres la página.'}
          </p>
        </div>
      </div>
      {supported && (
        <button className={on ? 'btn-outline py-2' : 'btn-brand py-2'} onClick={() => void toggle()} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {on ? 'Apagar avisos' : 'Activar avisos'}
        </button>
      )}
      {error && <div className="w-full"><Notice kind="error">{error}</Notice></div>}
    </div>
  );
}
