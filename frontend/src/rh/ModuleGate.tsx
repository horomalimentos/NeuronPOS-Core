import { Lock } from 'lucide-react';
import { Outlet } from 'react-router-dom';
import { useAdmin } from '../restaurant/context';

/** Muestra las pantallas solo si el restaurante tiene el modulo (como PosGate). */
export default function ModuleGate({ code, name }: { code: string; name: string }) {
  const ctx = useAdmin();
  const mod = ctx.me.modules.find((m) => m.code === code);
  if (!mod?.enabled || ctx.me.restaurant.access_error) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <Lock className="mx-auto mb-3 h-8 w-8 text-gray-500" />
        <h1 className="text-lg font-semibold text-white">{name} no disponible</h1>
        <p className="mt-2 text-sm text-gray-400">
          {ctx.me.restaurant.access_error?.error || `Tu restaurante no tiene contratado el módulo "${name}". Comunícate con NeuronPOS para contratarlo.`}
        </p>
      </div>
    );
  }
  return <Outlet context={ctx} />;
}
