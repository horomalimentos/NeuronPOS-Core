// Tipos de domicilios (fase 5): reparto propio, flota de la plataforma,
// cortes y liquidaciones. Los montos llegan como string (numeric de Postgres).

export type DeliveryStatus = 'solicitado' | 'asignado' | 'recogido' | 'en_camino' | 'entregado' | 'fallido' | 'cancelado';
export type DeliveryMode = 'propio' | 'horom';

export interface DeliveryConfig {
  mode: DeliveryMode;
  horom_enabled: boolean;
  horom_fee_type?: 'fixed' | 'percent';
  horom_fee_value?: string;
  updated_at?: string | null;
}

/** Reparto de una orden (propio o de la flota) como lo ve la caja. */
export interface Delivery {
  kind: DeliveryMode;
  id: string;
  order_id: string;
  status: DeliveryStatus;
  status_label: string;
  driver_id: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  cash_to_collect: string;
  cash_collected: string;
  fail_reason: string | null;
  cancel_reason: string | null;
  assigned_at: string | null;
  picked_up_at: string | null;
  on_way_at: string | null;
  delivered_at: string | null;
  created_at: string;
  commission_amount?: string;
}

export type DispatchStage = 'por_asignar' | 'en_reparto' | 'entregado' | 'cerrado';

export interface DispatchOrder {
  id: string;
  branch_id: string;
  folio: number;
  source: 'pos' | 'web';
  status: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  delivery_reference: string | null;
  notes: string | null;
  total: string;
  paid_amount: string;
  remaining: number;
  payment_preference: 'efectivo' | 'tarjeta' | null;
  pay_with: string | null;
  ready_at: string | null;
  dispatched_at: string | null;
  created_at: string;
  stage: DispatchStage;
  delivery: Delivery | null;
  history: Delivery[];
}

export interface BranchDriver {
  id: string;
  name: string;
  email: string;
  on_duty: boolean;
  latitude: string | null;
  longitude: string | null;
  located_at: string | null;
  active_count: number;
  cash_pending: string;
}

export interface DispatchBoard {
  settings: DeliveryConfig;
  orders: DispatchOrder[];
  drivers: BranchDriver[];
}

export interface MapDriver {
  kind: DeliveryMode;
  id: string;
  name: string;
  folio: number | null;
  status?: DeliveryStatus;
  latitude: string;
  longitude: string;
  located_at: string;
}

export interface DriverPayment {
  id: string;
  order_id: string;
  folio: number;
  customer_name: string | null;
  amount: string;
  tip: string;
  created_at: string;
}

export interface PendingCut {
  driver_user_id: string;
  name: string;
  active_deliveries: number;
  expected_cash: number;
  deliveries_count: number;
  payments: DriverPayment[];
}

export interface DriverCut {
  id: string;
  driver_name: string;
  terminal: string;
  expected_cash: string;
  counted_cash: string;
  difference: string;
  deliveries_count: number;
  notes: string | null;
  created_at: string;
  created_by_name: string;
}

export interface Settlement {
  id: string;
  cash_amount: string;
  commission_amount: string;
  net_amount: string;
  deliveries_count: number;
  method: 'transferencia' | 'efectivo' | 'otro';
  reference: string | null;
  notes: string | null;
  created_at: string;
  created_by_name?: string | null;
}

export interface LedgerSummary {
  cash_pending: number;
  commission_pending: number;
  cash_deliveries: number;
  commission_deliveries: number;
  payout_now: number;
}

// ---------------------------------------------------------------------------
// App del repartidor
// ---------------------------------------------------------------------------

/** Pedido en la app del repartidor (propio o de la flota, normalizado). */
export interface DriverJob {
  id: string;
  status: DeliveryStatus;
  status_label: string;
  folio: number;
  restaurant_name?: string;
  pickup_name: string;
  pickup_address: string | null;
  pickup_phone: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  address: string | null;
  reference: string | null;
  notes: string | null;
  total: string;
  to_collect: number;
  pay_with: string | null;
  cash_collected: string;
  maps_url: string | null;
  waze_url: string | null;
  items: { name: string; quantity: number; notes: string | null }[];
  fail_reason: string | null;
  delivered_at: string | null;
}

export interface FleetOffer {
  id: string;
  request_id: string;
  expires_at: string;
  summary: { restaurant_name: string; pickup_name: string; pickup_address: string | null; dropoff_area: string | null; cash_to_collect: string };
}

// ---------------------------------------------------------------------------
// Panel: flota
// ---------------------------------------------------------------------------

export interface FleetDriver {
  id: string;
  name: string;
  phone: string;
  email: string;
  vehicle: string | null;
  plate: string | null;
  active: boolean;
  pay_per_delivery: string | null;
  on_duty: boolean;
  notes: string | null;
  last_login_at: string | null;
  latitude: string | null;
  longitude: string | null;
  located_at: string | null;
  active_requests: number;
  cash_pending: string;
}

export interface FleetRequest {
  id: string;
  restaurant_id: string;
  restaurant_name: string;
  order_folio: number;
  pickup_name: string;
  pickup_address: string | null;
  pickup_phone: string | null;
  customer_name: string;
  customer_phone: string | null;
  dropoff_address: string;
  dropoff_reference: string | null;
  notes: string | null;
  order_total: string;
  cash_to_collect: string;
  status: DeliveryStatus;
  status_label: string;
  driver_id: string | null;
  driver_name: string | null;
  commission_amount: string;
  commission_invoice_id: string | null;
  commission_settlement_id: string | null;
  cash_collected: string;
  driver_pay: string;
  fail_reason: string | null;
  open_offers: number;
  created_at: string;
  assigned_at: string | null;
  delivered_at: string | null;
}

export interface FleetSettings {
  driver_pay_per_delivery: string;
  auto_offer: boolean;
  offer_seconds: number;
}

export interface LedgerRestaurant extends LedgerSummary {
  id: string;
  name: string;
  slug: string;
  mode: DeliveryMode;
  horom_enabled: boolean;
  horom_fee_type: 'fixed' | 'percent';
  horom_fee_value: string;
  last_settlement: { created_at: string; net_amount: string } | null;
}
