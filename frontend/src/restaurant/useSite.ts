import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { applyBranding } from '../lib/branding';
import type { PublicSite } from '../lib/types';

/** Carga /api/public/site para el restaurante resuelto y aplica su marca. */
export function useSite() {
  const [site, setSite] = useState<PublicSite | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'not_found' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    api<PublicSite>('/public/site', { noRedirect: true })
      .then((s) => {
        if (cancelled) return;
        setSite(s);
        setState('ok');
        applyBranding(s.restaurant.primary_color, s.restaurant.secondary_color);
        document.title = s.restaurant.name;
      })
      .catch((err) => {
        if (!cancelled) setState(err instanceof ApiError && err.status === 404 ? 'not_found' : 'error');
      });
    return () => { cancelled = true; };
  }, []);

  return { site, state };
}
