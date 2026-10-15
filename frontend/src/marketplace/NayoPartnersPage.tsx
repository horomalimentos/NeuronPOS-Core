import { ArrowLeft, ArrowRight, Bike, Briefcase, Store, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NayoLogo } from '../components/NayoLogo';
import { useNayoFavicon } from '../components/useNayoFavicon';
import { api } from '../lib/api';
import { resetBranding } from '../lib/branding';
import type { MarketplaceInfo } from './lib';
import { nayoPath } from './nayoUrl';

/**
 * Nayo Socios (/socios): la parte de Nayo para restaurantes y repartidores,
 * separada de la pagina de clientes (que solo es para pedir).
 */
export default function NayoPartnersPage() {
  const [info, setInfo] = useState<MarketplaceInfo | null>(null);
  useNayoFavicon();
  useEffect(() => {
    resetBranding();
    document.title = 'Nayo Socios';
    api<MarketplaceInfo>('/marketplace/info', { noRedirect: true }).then(setInfo).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="border-b border-slate-700/60 bg-slate-950/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <NayoLogo size="sm" />
            <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-sky-300">Socios</span>
          </div>
          <Link to={nayoPath()} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Quiero pedir comida
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 pb-8 pt-10 sm:pt-14">
        <div className="inline-flex items-center gap-2 rounded-full bg-sky-500/15 px-3 py-1 text-xs font-semibold text-sky-300">
          <Briefcase className="h-3.5 w-3.5" /> Para restaurantes y repartidores
        </div>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Trabaja con Nayo</h1>
        <p className="mt-3 max-w-2xl text-lg text-slate-400">
          Vende a domicilio o reparte en tu zona. Sin mensualidad para restaurantes ni para repartidores.
        </p>
      </div>

      <div className="mx-auto grid max-w-5xl gap-4 px-4 pb-16 md:grid-cols-2">
        <section className="flex flex-col rounded-2xl border border-slate-700/60 bg-slate-800/60 p-6">
          <Store className="mb-3 h-8 w-8 text-sky-300" />
          <h2 className="text-xl font-semibold text-white">¿Tienes un restaurante?</h2>
          <ul className="mt-3 flex-1 space-y-2 text-sm text-slate-300">
            <li>Regístrate gratis, sube tu menú y tu horario.</li>
            <li>NeuronPOS revisa tu registro y te aprueba.</li>
            <li>Recibe los pedidos en tu panel y habla con el cliente y el repartidor.</li>
            <li>{info && info.food_commission_pct > 0 ? `Comisión de ${info.food_commission_pct} % sobre la comida.` : 'Sin comisión sobre tu comida.'}</li>
          </ul>
          <Link to={nayoPath('/restaurantes')} className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-contrast hover:bg-brand/90">
            Registrar mi restaurante <ArrowRight className="h-4 w-4" />
          </Link>
        </section>

        <section className="flex flex-col rounded-2xl border border-slate-700/60 bg-slate-800/60 p-6">
          <Bike className="mb-3 h-8 w-8 text-sky-300" />
          <h2 className="text-xl font-semibold text-white">¿Quieres repartir?</h2>
          <ul className="mt-3 flex-1 space-y-2 text-sm text-slate-300">
            <li>Elige tu epicentro y cuántos kilómetros a la redonda quieres cubrir.</li>
            <li>Conéctate cuando quieras y acepta los pedidos de tu zona.</li>
            <li className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-emerald-400" /> {info ? `Te quedas con el ${info.driver_share_pct} % de cada envío.` : 'Te quedas con la mayor parte de cada envío.'}
            </li>
          </ul>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to={nayoPath('/repartidores')} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-contrast hover:bg-brand/90">
              Quiero repartir <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/repartidor" className="inline-flex items-center justify-center rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700">
              Ya soy repartidor
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
