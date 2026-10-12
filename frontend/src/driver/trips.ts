// Modelo comun de la app del repartidor: los pedidos de Nayo, los de la flota
// y los del restaurante se ven igual (como en Uber, Rappi o DiDi): una parada
// para recoger y otra para entregar, con el dinero de cada paso.
import type { Point } from '../components/ZoneMap';
import { NEXT_DRIVER_STEP } from '../delivery/lib';
import type { DeliveryStatus, DriverJob, FleetOffer } from '../delivery/types';

export type Source = 'nayo' | 'flota' | 'propio';

export interface Stop {
  name: string;
  address: string | null;
  reference?: string | null;
  phone: string | null;
  point: Point | null;
  mapsUrl: string | null;
  wazeUrl: string | null;
}

export interface Trip {
  key: string;
  source: Source;
  id: string;
  folio: number;
  /** recoger: va al restaurante; entregar: va con el cliente. */
  stage: 'recoger' | 'entregar';
  status: string;
  restaurant: string | null;
  pickup: Stop;
  dropoff: Stop;
  /** Efectivo que cobra al cliente (0 si ya esta pagado). */
  collect: number;
  /** Comida que paga en el restaurante (Nayo). */
  payFood: number;
  /** Lo que gana el repartidor, si se sabe. */
  earn: number | null;
  card: boolean;
  payWith: number | null;
  change: number | null;
  notes: string | null;
  items: string | null;
  readyAt: string | null;
  messages: number;
  /** Siguiente paso (flota y restaurante). */
  next: { status: DeliveryStatus; label: string } | null;
  job?: DriverJob;
}

/** Pedido de Nayo disponible (sin datos del cliente). */
export interface NayoOffer {
  id: string; restaurant_name: string; pickup_address: string | null; status: string; distance_km: number;
  driver_share: string; payment_method: 'efectivo' | 'tarjeta'; food_total: string; collect: string;
  estimated_ready_at: string | null; created_at: string; pickup: Point | null;
}

/** Pedido de Nayo que lleva el repartidor. */
export interface NayoJob extends NayoOffer {
  folio: number; pickup_phone: string | null; pickup_maps_url: string | null; pickup_waze_url: string | null;
  customer_name: string; customer_phone: string; address: string; reference: string | null; dropoff_maps_url: string;
  dropoff_waze_url: string; dropoff: Point | null; pay_with: string | null; change: number | null; total: string;
  delivery_fee: string; platform_share: string; picked_up_at: string | null; messages: number;
}

export interface NayoBoard {
  balance: number; debt_limit: number; cash_blocked: boolean; card_payments: boolean;
  today: { deliveries: number; earned: string }; week: { deliveries: number; earned: string };
  recent: { id: string; folio: number; restaurant_name: string; payment_method: string; driver_share: string; delivered_at: string }[];
  max_orders: number; active: NayoJob[]; available: NayoOffer[];
}

const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? 0 : Number(v));

export function fromNayo(j: NayoJob): Trip {
  const card = j.payment_method === 'tarjeta';
  return {
    key: `nayo:${j.id}`,
    source: 'nayo',
    id: j.id,
    folio: j.folio,
    stage: j.status === 'en_camino' ? 'entregar' : 'recoger',
    status: j.status,
    restaurant: j.restaurant_name,
    pickup: {
      name: j.restaurant_name, address: j.pickup_address, phone: j.pickup_phone, point: j.pickup,
      mapsUrl: j.pickup_maps_url, wazeUrl: j.pickup_waze_url,
    },
    dropoff: {
      name: j.customer_name, address: j.address, reference: j.reference, phone: j.customer_phone, point: j.dropoff,
      mapsUrl: j.dropoff_maps_url, wazeUrl: j.dropoff_waze_url,
    },
    collect: card ? 0 : money(j.total),
    payFood: money(j.food_total),
    earn: money(j.driver_share),
    card,
    payWith: j.pay_with ? money(j.pay_with) : null,
    change: j.change,
    notes: null,
    items: null,
    readyAt: j.estimated_ready_at,
    messages: j.messages,
    next: null,
  };
}

export function fromJob(j: DriverJob, source: 'flota' | 'propio'): Trip {
  return {
    key: `${source}:${j.id}`,
    source,
    id: j.id,
    folio: j.folio,
    stage: j.status === 'asignado' ? 'recoger' : 'entregar',
    status: j.status,
    restaurant: j.restaurant_name ?? null,
    pickup: {
      name: j.pickup_name, address: j.pickup_address, phone: j.pickup_phone, point: null,
      mapsUrl: j.pickup_address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.pickup_address)}` : null,
      wazeUrl: j.pickup_address ? `https://waze.com/ul?q=${encodeURIComponent(j.pickup_address)}&navigate=yes` : null,
    },
    dropoff: {
      name: j.customer_name || 'Cliente', address: j.address, reference: j.reference, phone: j.customer_phone, point: null,
      mapsUrl: j.maps_url, wazeUrl: j.waze_url,
    },
    collect: j.to_collect,
    payFood: 0,
    earn: null,
    card: false,
    payWith: j.pay_with ? money(j.pay_with) : null,
    change: j.pay_with ? Math.max(0, Math.round((money(j.pay_with) - j.to_collect) * 100) / 100) : null,
    notes: j.notes,
    items: j.items.length ? j.items.map((i) => `${i.quantity}× ${i.name}`).join(' · ') : null,
    readyAt: null,
    messages: 0,
    next: NEXT_DRIVER_STEP[j.status] ?? null,
    job: j,
  };
}

export const ACTIVE_JOB: DeliveryStatus[] = ['asignado', 'recogido', 'en_camino'];

/** Texto del boton deslizable para el paso actual. */
export function swipeLabel(t: Trip): string {
  if (t.source === 'nayo') return t.stage === 'recoger' ? 'Desliza: recogí y pagué' : 'Desliza: entregado';
  if (!t.next) return '';
  return { recogido: 'Desliza: ya lo recogí', en_camino: 'Desliza: voy en camino', entregado: 'Desliza: entregado' }[t.next.status as string]
    ?? `Desliza: ${t.next.label.toLowerCase()}`;
}

/** Pedido nuevo para la tarjeta de aceptar: de Nayo o de la flota. */
export type AnyOffer = { kind: 'nayo'; offer: NayoOffer } | { kind: 'flota'; offer: FleetOffer };
export const offerKey = (o: AnyOffer) => `${o.kind}:${o.offer.id}`;
