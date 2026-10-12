import { ArrowRight, MapPin, Receipt, UserRound } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import InstallApp from '../components/InstallApp';
import { NayoLogo } from '../components/NayoLogo';
import { PushBell } from '../components/PushBell';
import { useNayoFavicon } from '../components/useNayoFavicon';
import { resetBranding } from '../lib/branding';
import ActiveOrderBubble from './ActiveOrderBubble';
import { accountStore, ordersStore, signOut, useNayoSignedIn, useStore } from './customer';
import NayoLoginGate from './NayoLoginGate';
import NearbyRestaurants from './NearbyRestaurants';
import { nayoPath } from './nayoUrl';

/**
 * Pagina de Nayo (/nayo): el cliente elige donde le
 * entregan y ve los restaurantes cercanos con el envio ya calculado a su
 * domicilio (sin la tabla de tarifas). Lo de
 * restaurantes y repartidores vive aparte, en Nayo Socios (/socios).
 */
export default function DeliveryLanding() {
  const recent = useStore(ordersStore);
  const signedIn = useNayoSignedIn();
  useNayoFavicon();
  useEffect(() => {
    resetBranding();
    document.title = 'Nayo';
  }, []);
  // Sin sesion solo se ve la bienvenida para entrar (lo pidio Alex).
  if (!signedIn) return <NayoLoginGate />;

  return (
    <div className="min-h-screen bg-gray-950 pb-28">
      <header className="sticky top-0 z-30 border-b border-gray-900 bg-gray-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <h1><NayoLogo size="sm" /></h1>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <InstallApp />
            <AccountChip />
          </div>
        </div>
      </header>
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative mx-auto max-w-5xl px-4 pb-4 pt-6">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-brand/15 px-3 py-1 text-xs font-semibold text-brand">
            <MapPin className="h-3.5 w-3.5" /> Local, de tu ciudad
          </div>
          <p className="max-w-2xl text-2xl font-bold text-white sm:text-3xl">¿Qué se te antoja hoy?</p>
          <p className="mt-1 max-w-2xl text-gray-400">Restaurantes cerca de ti y repartidores de tu zona.</p>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 pb-10">
        {recent.length > 0 && (
          <div className="no-scrollbar -mx-4 mb-4 flex items-center gap-2 overflow-x-auto px-4 text-sm">
            <Receipt className="h-4 w-4 shrink-0 text-gray-400" />
            <span className="shrink-0 text-gray-400">Tus pedidos:</span>
            {recent.slice(0, 5).map((o) => (
              <Link key={o.token} to={nayoPath(`/pedido/${o.token}`)} className="shrink-0 rounded-full bg-gray-800 px-3 py-1 text-gray-200 hover:bg-gray-700">{o.restaurant}</Link>
            ))}
          </div>
        )}
        <NearbyRestaurants />
      </div>

      <footer className="border-t border-gray-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-gray-500">
          <span>Nayo · pedidos locales</span>
          <Link to={nayoPath('/socios')} className="inline-flex items-center gap-1 text-gray-400 hover:text-white">
            ¿Tienes un restaurante o quieres repartir? <span className="font-semibold text-gray-200">Nayo Socios</span> <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </footer>
      <ActiveOrderBubble />
    </div>
  );
}

/** Tu cuenta de Nayo con la campanita de avisos y la opción de salir. */
function AccountChip() {
  const account = useStore(accountStore);
  if (!account) return null;
  return (
    <div className="flex items-center gap-2 rounded-full bg-gray-800/80 px-3 py-1.5 text-xs text-gray-300">
      <UserRound className="h-3.5 w-3.5 text-brand" /> {account.name}
      <PushBell target={{ realm: 'nayo', app: 'cliente' }} />
      <button type="button" onClick={signOut} className="text-gray-500 underline hover:text-white">Salir</button>
    </div>
  );
}
