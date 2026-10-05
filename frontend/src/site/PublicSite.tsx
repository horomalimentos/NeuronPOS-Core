import { ShoppingBag, Store } from 'lucide-react';
import { Link } from 'react-router-dom';
import BranchCards from './BranchCards';
import { hasModule, useSiteCtx } from './context';
import LandingPage from './LandingPage';

/**
 * Raiz del dominio del restaurante. Con el modulo "Sitio web" se muestra la
 * pagina completa; sin el, una pagina minima con el nombre y, si tiene
 * pedidos en linea, el enlace para ordenar.
 */
export default function PublicSite() {
  const { site } = useSiteCtx();
  if (hasModule(site, 'landing')) return <LandingPage />;

  const r = site.restaurant;
  const portal = hasModule(site, 'portal');
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-center">
      {r.logo_url
        ? <img src={r.logo_url} alt={r.name} className="mx-auto mb-6 h-24 object-contain" />
        : <span className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-brand text-brand-contrast"><Store className="h-10 w-10" /></span>}
      <h1 className="text-4xl font-bold text-gray-900">{r.name}</h1>
      {portal ? (
        <Link to="/pedir" className="btn-brand mt-8 px-7 py-3.5 text-base"><ShoppingBag className="h-5 w-5" /> Ordenar en línea</Link>
      ) : (
        <p className="mt-4 text-gray-500">Sitio no disponible.</p>
      )}
      {portal && site.branches.length > 0 && (
        <div className="mt-12 text-left"><BranchCards branches={site.branches} /></div>
      )}
    </div>
  );
}
