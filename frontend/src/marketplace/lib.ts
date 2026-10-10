import type { Point } from '../components/ZoneMap';

/** Reglas publicas de NeuronPOS Delivery (GET /marketplace/info). */
export interface MarketplaceInfo {
  enabled: boolean;
  driver_share_pct: number;
  food_commission_pct: number;
  max_distance_km: number;
  driver_max_radius_km: number;
  fee_tiers: FeeTier[];
}

export interface FeeTier { up_to_km: number; fee: number }

export interface Listing {
  branch_id: string;
  branch_name: string;
  address: string | null;
  phone: string | null;
  branch_active: boolean;
  location: Point | null;
  description: string | null;
  cuisine: string | null;
  cover_url: string | null;
  prep_minutes: number;
  min_order: string;
  published: boolean;
  paused_until: string | null;
  blocked: boolean;
  blocked_reason: string | null;
  hours_days: number;
  products: number;
  missing: ('ubicacion' | 'horario' | 'menu')[];
  visible: boolean;
}

export type DriverStatus = 'pendiente' | 'aprobado' | 'rechazado' | 'bloqueado';

export const DRIVER_STATUS_LABEL: Record<DriverStatus, string> = {
  pendiente: 'En revisión',
  aprobado: 'Aprobado',
  rechazado: 'Rechazado',
  bloqueado: 'Bloqueado',
};

export const DRIVER_STATUS_STYLE: Record<DriverStatus, string> = {
  pendiente: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  aprobado: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  rechazado: 'bg-gray-500/15 text-gray-300 ring-gray-500/40',
  bloqueado: 'bg-red-500/15 text-red-300 ring-red-500/40',
};

/** Tramos de envio como texto: "hasta 3 km $35 · hasta 5 km $45". */
export const tiersText = (tiers: FeeTier[], money: (n: number) => string) =>
  tiers.map((t) => `hasta ${t.up_to_km} km ${money(t.fee)}`).join(' · ');

export interface NearbyRestaurant {
  branch_id: string; name: string; branch_name: string; logo_url: string | null; cuisine: string | null; description: string | null;
  cover_url: string | null; address: string | null; prep_minutes: number; min_order: number; distance_km: number | null;
  delivery_fee: number | null; open: boolean; today: { opens_at: string; closes_at: string } | null; has_driver: boolean;
  can_order: boolean; reason: 'lejos' | 'cerrado' | 'sin_repartidor' | 'sin_ubicacion' | null;
}

export const REASON_LABEL: Record<string, string> = {
  cerrado: 'Cerrado ahora',
  sin_repartidor: 'Sin repartidores cerca',
  lejos: 'No entrega hasta tu domicilio',
  sin_ubicacion: 'Elige dónde te entregamos',
};
