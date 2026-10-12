import { Banknote, CircleSlash, CreditCard, Navigation, Phone, Store, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { telHref } from '../delivery/lib';
import { fleetApi } from '../lib/api';
import { formatMXN } from '../lib/format';
import { ChatButton } from '../marketplace/OrderChat';
import { formatTime } from '../pos/lib';
import SwipeButton from './SwipeButton';
import { swipeLabel, type Trip } from './trips';

/**
 * Pedido en curso, como en Uber, Rappi o DiDi: los dos pasos arriba
 * (recoger y entregar), la parada actual con navegar, llamar y chat, el
 * dinero de ese paso y el boton deslizable para avanzar.
 */
export default function TripCard({ trip: t, busy, onAdvance, onSecondary }: {
  trip: Trip; busy: boolean; onAdvance: () => void; onSecondary: (() => void) | null;
}) {
  const pickup = t.stage === 'recoger';
  const stop = pickup ? t.pickup : t.dropoff;
  const label = swipeLabel(t);
  return (
    <div className="space-y-4">
      <Steps pickup={pickup} />

      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full ${pickup ? 'bg-brand/15 text-brand' : 'bg-emerald-500/15 text-emerald-400'}`}>
          {pickup ? <Store className="h-5 w-5" /> : <UserRound className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            {pickup ? 'Recoge en' : 'Entrega a'} · #{t.folio}
          </p>
          <p className="truncate text-lg font-bold text-white">{stop.name}</p>
          {stop.address && <p className="text-sm text-gray-300">{stop.address}</p>}
          {stop.reference && <p className="text-sm text-gray-500">{stop.reference}</p>}
          {pickup && t.readyAt && <p className="mt-0.5 text-xs text-gray-500">Listo cerca de las {formatTime(t.readyAt)}</p>}
          {!pickup && t.restaurant && t.source !== 'propio' && <p className="mt-0.5 text-xs text-gray-500">Pedido de {t.restaurant}</p>}
        </div>
      </div>

      <div className="flex gap-2">
        <Action href={stop.mapsUrl} icon={<Navigation className="h-5 w-5" />} label="Navegar" primary />
        <Action href={stop.wazeUrl} icon={<WazeIcon />} label="Waze" />
        <Action href={telHref(stop.phone)} icon={<Phone className="h-5 w-5" />} label="Llamar" />
        {t.source === 'nayo' && (
          <ChatButton chatKey={`d:${t.id}`} count={t.messages} title={`Chat del pedido #${t.folio}`} me="repartidor"
            path={`/fleet/marketplace/orders/${t.id}/messages`} call={fleetApi}
            className="!flex-1 !flex-col !gap-1 !rounded-2xl !border-0 !bg-gray-800 !px-0 !py-2.5 !text-xs" />
        )}
      </div>

      <Money trip={t} />

      {t.notes && <p className="rounded-xl bg-gray-800/60 px-3 py-2 text-sm italic text-gray-300">“{t.notes}”</p>}
      {t.items && <p className="text-xs text-gray-500">{t.items}</p>}

      {label && <SwipeButton label={label} onConfirm={onAdvance} loading={busy} tone={pickup ? 'brand' : 'green'} />}
      {onSecondary && (
        <button type="button" onClick={onSecondary}
          className="flex w-full items-center justify-center gap-2 py-1 text-sm font-medium text-gray-400 hover:text-white">
          {t.source === 'nayo' ? 'Soltar este pedido' : <><CircleSlash className="h-4 w-4" /> No se pudo entregar</>}
        </button>
      )}
    </div>
  );
}

function Steps({ pickup }: { pickup: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold">
      <span className={`flex items-center gap-1.5 ${pickup ? 'text-brand' : 'text-gray-500'}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${pickup ? 'bg-brand' : 'bg-gray-600'}`} /> Recoger
      </span>
      <span className={`h-0.5 flex-1 rounded ${pickup ? 'bg-gray-700' : 'bg-emerald-500'}`} />
      <span className={`flex items-center gap-1.5 ${pickup ? 'text-gray-500' : 'text-emerald-400'}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${pickup ? 'bg-gray-600' : 'bg-emerald-500'}`} /> Entregar
      </span>
    </div>
  );
}

function Action({ href, icon, label, primary }: { href: string | null | undefined; icon: ReactNode; label: string; primary?: boolean }) {
  return (
    <a href={href || undefined} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer"
      className={`flex flex-1 flex-col items-center gap-1 rounded-2xl py-2.5 text-xs font-medium
        ${primary ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-200'} ${href ? '' : 'pointer-events-none opacity-40'}`}>
      {icon} {label}
    </a>
  );
}

function WazeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 15c-1-1.5-1-3.5-.5-5C5 6 8.5 4 12.5 4 17 4 20 7.5 20 11.5c0 3.5-2.5 6-6 6.5H10c-1 0-2-.3-2.8-.8" />
      <circle cx="9.5" cy="10" r=".8" fill="currentColor" /><circle cx="14.5" cy="10" r=".8" fill="currentColor" />
      <circle cx="8" cy="19" r="1.6" /><circle cx="16" cy="19" r="1.6" />
    </svg>
  );
}

/** El dinero del paso actual, en grande y sin ambiguedad. */
function Money({ trip: t }: { trip: Trip }) {
  if (t.source === 'nayo' && t.stage === 'recoger') {
    return (
      <Box tone="amber" icon={<Banknote className="h-5 w-5" />} title={`Paga ${formatMXN(t.payFood)} de la comida`}
        text={t.card ? 'El cliente pagó con tarjeta: te abonamos la comida y tu envío al entregar.' : `Luego cobras ${formatMXN(t.collect)} al cliente.`} />
    );
  }
  if (t.card) {
    return (
      <Box tone="green" icon={<CreditCard className="h-5 w-5" />} title="Pagado con tarjeta: no cobres"
        text={t.earn !== null ? `Te abonamos ${formatMXN(t.payFood + t.earn)} (comida + tu envío).` : undefined} />
    );
  }
  if (t.collect > 0) {
    return (
      <Box tone="amber" icon={<Banknote className="h-5 w-5" />} title={`Cobra ${formatMXN(t.collect)} en efectivo`}
        text={t.payWith && t.change ? `Paga con ${formatMXN(t.payWith)}: lleva ${formatMXN(t.change)} de cambio.` : undefined} />
    );
  }
  return <Box tone="green" icon={<CreditCard className="h-5 w-5" />} title="Ya está pagado: no cobres" />;
}

function Box({ tone, icon, title, text }: { tone: 'amber' | 'green'; icon: ReactNode; title: string; text?: string }) {
  const s = tone === 'amber' ? 'bg-amber-500/10 text-amber-200 ring-amber-500/30' : 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30';
  return (
    <div className={`flex items-start gap-3 rounded-2xl px-4 py-3 ring-1 ${s}`}>
      <span className="mt-0.5">{icon}</span>
      <div>
        <p className="text-base font-bold">{title}</p>
        {text && <p className="text-sm opacity-80">{text}</p>}
      </div>
    </div>
  );
}
