import { ArrowRight, Bike, MapPin, Store, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { resetBranding } from '../lib/branding';
import { formatMXN } from '../lib/format';
import type { MarketplaceInfo } from './lib';

/**
 * Pagina de NeuronPOS Delivery (/delivery). En la fase 1 invita a
 * restaurantes y repartidores a registrarse gratis y muestra las tarifas de
 * envio; en la fase 2 aqui mismo los clientes veran los restaurantes cercanos.
 */
export default function DeliveryLanding() {
  const [info, setInfo] = useState<MarketplaceInfo | null>(null);
  useEffect(() => {
    resetBranding();
    document.title = 'NeuronPOS Delivery';
    api<MarketplaceInfo>('/marketplace/info', { noRedirect: true }).then(setInfo).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative mx-auto max-w-5xl px-4 pb-10 pt-14 sm:pt-20">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-brand/15 px-3 py-1 text-xs font-semibold text-brand">
            <MapPin className="h-3.5 w-3.5" /> Local, de tu ciudad
          </div>
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-white sm:text-5xl">NeuronPOS Delivery</h1>
          <p className="mt-4 max-w-2xl text-lg text-gray-400">
            Pide a los restaurantes cerca de ti y recibe con repartidores de tu zona. Sin mensualidad para restaurantes ni
            para repartidores.
          </p>
        </div>
      </div>

      <div className="mx-auto grid max-w-5xl gap-4 px-4 pb-10 md:grid-cols-2">
        <section className="card flex flex-col p-6">
          <Store className="mb-3 h-8 w-8 text-brand" />
          <h2 className="text-xl font-semibold text-white">¿Tienes un restaurante?</h2>
          <ul className="mt-3 flex-1 space-y-2 text-sm text-gray-300">
            <li>Regístrate gratis, sube tu menú y tu horario.</li>
            <li>Recibe los pedidos en tu panel y habla con el cliente y el repartidor.</li>
            <li>{info && info.food_commission_pct > 0 ? `Comisión de ${info.food_commission_pct} % sobre la comida.` : 'Sin comisión sobre tu comida.'}</li>
          </ul>
          <Link to="/delivery/restaurantes" className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-contrast hover:bg-brand/90">
            Registrar mi restaurante <ArrowRight className="h-4 w-4" />
          </Link>
        </section>

        <section className="card flex flex-col p-6">
          <Bike className="mb-3 h-8 w-8 text-brand" />
          <h2 className="text-xl font-semibold text-white">¿Quieres repartir?</h2>
          <ul className="mt-3 flex-1 space-y-2 text-sm text-gray-300">
            <li>Elige tu epicentro y cuántos kilómetros a la redonda quieres cubrir.</li>
            <li>Conéctate cuando quieras y acepta los pedidos de tu zona.</li>
            <li className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-emerald-400" /> Te quedas con el {info?.driver_share_pct ?? 80} % de cada envío.
            </li>
          </ul>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to="/delivery/repartidores" className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-contrast hover:bg-brand/90">
              Quiero repartir <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/repartidor" className="inline-flex items-center justify-center rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 hover:bg-gray-800">
              Ya tengo cuenta
            </Link>
          </div>
        </section>
      </div>

      {info && info.fee_tiers.length > 0 && (
        <div className="mx-auto max-w-5xl px-4 pb-16">
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
    </div>
  );
}
