import { Banknote, ChevronRight, Clock, CreditCard, MapPin, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui';
import { formatMXN } from '../lib/format';
import { formatTime } from '../pos/lib';
import type { AnyOffer } from './trips';


/**
 * Pedido nuevo, como la tarjeta de Uber o DiDi: lo que ganas en grande, la
 * distancia, como se paga y el restaurante; Aceptar y Ahora no.
 */
export default function OfferCard({ item, index, count, busy, onAccept, onSkip }: {
  item: AnyOffer; index: number; count: number; busy: boolean; onAccept: () => void; onSkip: () => void;
}) {
  const nayo = item.kind === 'nayo' ? item.offer : null;
  const fleet = item.kind === 'flota' ? item.offer : null;
  const left = useCountdown(fleet?.expires_at ?? null);
  const card = nayo?.payment_method === 'tarjeta';
  return (
    <div className="overflow-hidden rounded-3xl bg-[#1A1714] shadow-2xl ring-1 ring-brand/40">
      <div className="flex items-center justify-between bg-brand px-5 py-2 text-sm font-bold text-brand-contrast">
        <span>Nuevo pedido{count > 1 ? ` · ${index + 1} de ${count}` : ''}</span>
        {left !== null && <span className="flex items-center gap-1"><Clock className="h-4 w-4" /> {left}</span>}
      </div>
      <div className="space-y-4 p-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{nayo ? 'Ganas' : 'Pedido de la flota'}</p>
            <p className={`font-black tracking-tight text-white ${nayo ? 'text-4xl' : 'text-2xl'}`}>{nayo ? formatMXN(nayo.driver_share) : fleet?.summary.restaurant_name}</p>
          </div>
          {nayo && (
            <span className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${card ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
              {card ? <CreditCard className="h-3.5 w-3.5" /> : <Banknote className="h-3.5 w-3.5" />} {card ? 'Tarjeta' : 'Efectivo'}
            </span>
          )}
        </div>

        <ol className="relative space-y-3 border-l-2 border-dashed border-gray-700 pl-5 text-sm">
          <li className="relative">
            <span className="absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand"><Store className="h-2.5 w-2.5 text-gray-900" /></span>
            <p className="font-semibold text-white">{nayo ? nayo.restaurant_name : fleet?.summary.pickup_name}</p>
            <p className="text-gray-400">{nayo ? nayo.pickup_address : fleet?.summary.pickup_address}</p>
            {nayo?.estimated_ready_at && <p className="text-xs text-gray-500">Listo cerca de las {formatTime(nayo.estimated_ready_at)}</p>}
          </li>
          <li className="relative">
            <span className="absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500"><MapPin className="h-2.5 w-2.5 text-white" /></span>
            <p className="font-semibold text-white">{nayo ? `Entrega a ${nayo.distance_km.toFixed(1)} km del restaurante` : fleet?.summary.dropoff_area || 'Entrega al cliente'}</p>
          </li>
        </ol>

        {nayo ? (
          <p className="rounded-xl bg-gray-800/70 px-3 py-2 text-sm text-gray-300">
            {card
              ? <>Pagas {formatMXN(nayo.food_total)} en el restaurante y te lo abonamos con tu envío.</>
              : <>Pagas {formatMXN(nayo.food_total)} en el restaurante y cobras {formatMXN(nayo.collect)} al cliente.</>}
          </p>
        ) : Number(fleet?.summary.cash_to_collect) > 0 && (
          <p className="rounded-xl bg-gray-800/70 px-3 py-2 text-sm text-amber-200">Cobras {formatMXN(fleet!.summary.cash_to_collect)} al cliente.</p>
        )}

        <Button className="w-full py-4 text-lg" loading={busy} onClick={onAccept}>Aceptar pedido</Button>
        <button type="button" onClick={onSkip} className="flex w-full items-center justify-center gap-1 text-sm font-medium text-gray-400 hover:text-white">
          {fleet ? 'No puedo' : 'Ahora no'}{count > 1 && <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

/** "4:59" hasta que vence la oferta de la flota. */
function useCountdown(iso: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
