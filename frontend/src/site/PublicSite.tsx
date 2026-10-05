import { BrainCircuit, MapPin, Phone, Store } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/ui';
import { useSite } from '../restaurant/useSite';

// Raiz del dominio. Con restaurante resuelto: vista previa del sitio (el
// modulo "Sitio web" completo llega despues). Sin restaurante: portada de
// NeuronPOS con accesos.
export default function PublicSite() {
  const { site, state } = useSite();
  if (state === 'loading') return <Spinner />;

  if (!site) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
        <BrainCircuit className="h-14 w-14 text-brand" />
        <h1 className="text-3xl font-semibold text-white">NeuronPOS</h1>
        <p className="max-w-md text-gray-400">Punto de venta, sitio web, pedidos en línea, recursos humanos y domicilios para tu restaurante.</p>
        <div className="flex gap-3">
          <Link to="/admin/login" className="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-contrast">Entrar a mi restaurante</Link>
          <Link to="/panel" className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm text-gray-300">Panel NeuronPOS</Link>
        </div>
      </div>
    );
  }

  const r = site.restaurant;
  return (
    <div className="min-h-screen bg-gray-950">
      <header className="bg-brand-secondary">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            {r.logo_url ? <img src={r.logo_url} alt={r.name} className="h-10 object-contain" /> : <Store className="h-8 w-8 text-brand" />}
            <span className="text-lg font-semibold text-white">{r.name}</span>
          </div>
          <Link to="/admin/login" className="text-sm text-white/70 hover:text-white">Personal</Link>
        </div>
        <div className="h-1 bg-brand" />
      </header>
      <main className="mx-auto max-w-4xl px-6 py-16">
        {!r.available ? (
          <p className="text-center text-gray-400">Este sitio no está disponible por el momento.</p>
        ) : (
          <>
            <h1 className="text-4xl font-bold text-white">{r.name}</h1>
            <p className="mt-3 text-gray-400">
              {site.modules.includes('landing') ? 'Muy pronto nuestro menú en línea.' : 'Bienvenido.'}
            </p>
            {site.branches.length > 0 && (
              <div className="mt-10 grid gap-4 sm:grid-cols-2">
                {site.branches.map((b) => (
                  <div key={b.name} className="card p-5">
                    <h2 className="font-semibold text-white">{b.name}</h2>
                    {b.address && <p className="mt-2 flex gap-2 text-sm text-gray-400"><MapPin className="h-4 w-4 flex-shrink-0 text-brand" />{b.address}</p>}
                    {b.phone && <p className="mt-1 flex gap-2 text-sm text-gray-400"><Phone className="h-4 w-4 flex-shrink-0 text-brand" />{b.phone}</p>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
