import { Lock } from 'lucide-react';
import { Outlet } from 'react-router-dom';
import { useAdmin } from '../restaurant/context';

/** Muestra las pantallas del POS solo si el restaurante tiene el modulo. */
export default function PosGate() {
  const ctx = useAdmin();
  const pos = ctx.me.modules.find((m) => m.code === 'pos');
  if (!pos?.enabled || ctx.me.restaurant.access_error) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <Lock className="mx-auto mb-3 h-8 w-8 text-gray-500" />
        <h1 className="text-lg font-semibold text-white">Punto de venta no disponible</h1>
        <p className="mt-2 text-sm text-gray-400">
          {ctx.me.restaurant.access_error?.error || 'Tu restaurante no tiene contratado el módulo "Punto de venta". Comunícate con NeuronPOS para contratarlo.'}
        </p>
      </div>
    );
  }
  return <Outlet context={ctx} />;
}
