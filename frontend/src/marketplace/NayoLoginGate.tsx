import { ArrowRight, Bike, MapPin, UtensilsCrossed } from 'lucide-react';
import { Link } from 'react-router-dom';
import { NayoLogo } from '../components/NayoLogo';
import { accountStore, useStore } from './customer';
import NayoAccountForm, { VerifyEmailForm } from './NayoAccountForm';
import { nayoPath } from './nayoUrl';

/**
 * Bienvenida de Nayo para clientes: hay que entrar (o crear la cuenta) y
 * confirmar el correo antes de ver restaurantes y menus, como en las apps
 * de reparto. El seguimiento de un pedido (/pedido/:token) sigue abierto.
 */
export default function NayoLoginGate() {
  const account = useStore(accountStore);
  return (
    <div className="min-h-screen bg-gray-950">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative mx-auto grid max-w-5xl items-center gap-8 px-4 py-10 lg:grid-cols-2">
          <div>
            <h1><NayoLogo size="lg" /></h1>
            <p className="mt-4 text-2xl font-bold text-white sm:text-3xl">¿Qué se te antoja hoy?</p>
            <ul className="mt-4 space-y-2 text-gray-300">
              <li className="flex items-center gap-2"><UtensilsCrossed className="h-5 w-5 text-brand" /> Restaurantes de tu ciudad</li>
              <li className="flex items-center gap-2"><MapPin className="h-5 w-5 text-brand" /> Envío según tu ubicación</li>
              <li className="flex items-center gap-2"><Bike className="h-5 w-5 text-brand" /> Repartidores de tu zona</li>
            </ul>
          </div>
          <section className="card space-y-3 p-5">
            <h2 className="text-lg font-semibold text-white">{account ? 'Confirma tu correo' : 'Entra a Nayo'}</h2>
            {account ? <VerifyEmailForm account={account} /> : <NayoAccountForm />}
          </section>
        </div>
      </div>
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
