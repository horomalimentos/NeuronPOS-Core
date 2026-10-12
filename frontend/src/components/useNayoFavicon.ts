import { useEffect } from 'react';

/** Pone el favicon del mandadero mientras se ve una pagina de Nayo. */
export function useNayoFavicon() {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const prev = link.href;
    link.href = '/nayo-favicon.svg';
    return () => { link.href = prev; };
  }, []);
}
