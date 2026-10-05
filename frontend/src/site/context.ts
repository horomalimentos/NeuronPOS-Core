import { useOutletContext } from 'react-router-dom';
import type { PublicSite } from '../lib/types';
import type { Customer } from './types';

export interface SiteContext {
  site: PublicSite;
  customer: Customer | null;
  /** Vuelve a leer la sesion del cliente (despues de entrar, salir o editar). */
  refreshCustomer: () => void;
  logout: () => void;
}

/** Datos del restaurante y del cliente que SiteLayout comparte con sus paginas. */
export const useSiteCtx = () => useOutletContext<SiteContext>();

export const hasModule = (site: PublicSite, code: string) => site.modules.includes(code);

/** <title> y meta description/og por restaurante (SEO basico en el navegador). */
export function setSeo(title: string, description?: string | null, image?: string | null) {
  document.title = title;
  const meta = (attr: 'name' | 'property', key: string, value: string | null | undefined) => {
    let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
    if (!value) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', value);
  };
  meta('name', 'description', description);
  meta('property', 'og:title', title);
  meta('property', 'og:description', description);
  meta('property', 'og:image', image);
}
