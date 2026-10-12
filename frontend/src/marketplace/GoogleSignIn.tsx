import { useEffect, useRef, useState } from 'react';
import { Alert } from '../components/ui';
import { errorMessage, nayoApi } from '../lib/api';
import { signIn, type NayoAccount } from './customer';

// "Continuar con Google" (Google Identity Services). El ID de cliente lo da el
// backend; si no hay, el boton no sale. Google regresa un id_token que el
// backend verifica en POST /marketplace/account/google.

interface Gsi {
  accounts: { id: {
    initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string; locale?: string }) => void;
    renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
  } };
}

let clientId: Promise<string | null> | null = null;
let script: Promise<Gsi> | null = null;

const loadClientId = () => {
  clientId ??= nayoApi<{ google_client_id: string | null }>('/marketplace/account/options')
    .then((r) => r.google_client_id).catch(() => null);
  return clientId;
};

const loadScript = () => {
  script ??= new Promise<Gsi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve((window as unknown as { google: Gsi }).google);
    s.onerror = () => { script = null; reject(new Error('No cargó Google')); };
    document.head.appendChild(s);
  });
  return script;
};

export default function GoogleSignIn({ onDone }: { onDone?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const id = await loadClientId();
      if (!id || !alive) return;
      try {
        const g = await loadScript();
        if (!alive || !box.current) return;
        g.accounts.id.initialize({
          client_id: id,
          ux_mode: 'popup',
          callback: ({ credential }) => {
            setError('');
            nayoApi<{ token: string; customer: NayoAccount }>('/marketplace/account/google', { method: 'POST', body: { credential } })
              .then((r) => { signIn(r.token, r.customer); done.current?.(); })
              .catch((e) => setError(errorMessage(e)));
          },
        });
        g.accounts.id.renderButton(box.current, {
          theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: 'es',
          width: Math.min(400, box.current.clientWidth || 320),
        });
        setReady(true);
      } catch { /* sin Google: queda el correo */ }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className={ready ? 'space-y-3' : ''}>
      <div ref={box} className="flex w-full justify-center" />
      {error && <Alert>{error}</Alert>}
      {ready && (
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="h-px flex-1 bg-gray-800" /> o con tu correo <span className="h-px flex-1 bg-gray-800" />
        </div>
      )}
    </div>
  );
}
