import { ArrowRight, MapPin, Receipt, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NayoLogo } from '../components/NayoLogo';
import { useNayoFavicon } from '../components/useNayoFavicon';
import { api } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import { accountStore, ordersStore, signOut, useStore } from './customer';
import type { MarketplaceInfo } from './lib';
import NearbyRestaurants from './NearbyRestaurants';
import { nayoPath } from './nayoUrl';

/**
 * Pagina de Nayo (/nayo): el cliente elige donde le
 * entregan y ve los restaurantes cercanos y las tarifas de envio. Lo de
 * restaurantes y repartidores vive aparte, en Nayo Socios (/socios).
 */
export default function DeliveryLanding() {
  const [info, setInfo] = useState<MarketplaceInfo | null>(null);
  const recent = useStore(ordersStore);
  useNayoFavicon();
  useEffect(() => {
    resetBranding();
    document.title = 'Nayo';
    api<MarketplaceInfo>('/marketplace/info', { noRedirect: true }).then(setInfo).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative mx-auto max-w-5xl px-4 pb-8 pt-10 sm:pt-14">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 rounded-full bg-brand/15 px-3 py-1 text-xs font-semibold text-brand">
              <MapPin className="h-3.5 w-3.5" /> Local, de tu ciudad
            </div>
            <AccountChip />
          </div>
          <h1><NayoLogo size="lg" /></h1>
          <p className="mt-4 max-w-2xl text-lg text-gray-400">
            Pide a los restaurantes cerca de ti y recibe en tu puerta con repartidores de tu zona.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 pb-10">
        {recent.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <Receipt className="h-4 w-4 text-gray-400" />
            <span className="text-gray-400">Tus pedidos:</span>
            {recent.slice(0, 3).map((o) => (
              <Link key={o.token} to={nayoPath(`/pedido/${o.token}`)} className="rounded-full bg-gray-800 px-3 py-1 text-gray-200 hover:bg-gray-700">{o.restaurant}</Link>
            ))}
          </div>
        )}
        <NearbyRestaurants />
      </div>

      {info && info.fee_tiers.length > 0 && (
        <div className="mx-auto max-w-5xl px-4 pb-10">
          <section className="card p-6">
            <h2 className="font-semibold text-white">Costo de envío</h2>
            <p className="mt-1 text-sm text-gray-400">Según la distancia en línea recta del restaurante a tu domicilio.</p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {info.fee_tiers.map((t) => (
                <div key={t.up_to_km} className="rounded-xl bg-gray-950/60 px-4 py-3">
                  <div className="text-xs text-gray-500">Hasta {t.up_to_km} km</div>
                  <div className="text-lg font-semibold text-white">{formatMXN(t.fee)}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      <footer className="border-t border-gray-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-gray-500">
          <span>Nayo · pedidos locales</span>
          <Link to={nayoPath('/socios')} className="inline-flex items-center gap-1 text-gray-400 hover:text-white">
            ¿Tienes un restaurante o quieres repartir? <span className="font-semibold text-gray-200">Nayo Socios</span> <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </footer>
    </div>
  );
}

/** Tu cuenta de Nayo (si ya entraste) con la opción de salir. */
function AccountChip() {
  const account = useStore(accountStore);
  if (!account) return null;
  return (
    <div className="flex items-center gap-2 rounded-full bg-gray-800/80 px-3 py-1.5 text-xs text-gray-300">
      <UserRound className="h-3.5 w-3.5 text-brand" /> {account.name}
      <button type="button" onClick={signOut} className="text-gray-500 underline hover:text-white">Salir</button>
    </div>
  );
}
