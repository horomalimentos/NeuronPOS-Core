// Pedidos de Nayo que ve el restaurante (GET /marketplace/orders).

export type DeliveryStatus = 'nuevo' | 'aceptado' | 'listo' | 'en_camino' | 'entregado' | 'rechazado' | 'cancelado';

export interface DeliveryOrder {
  id: string; branch_id: string; branch_name: string; folio: number; status: DeliveryStatus;
  customer_name: string; customer_phone: string; address: string; reference: string | null; distance_km: string;
  food_total: string; delivery_fee: string; total: string; pay_with: string | null; cancel_reason: string | null; notes: string | null;
  estimated_ready_at: string | null; created_at: string; accepted_at: string | null; ready_at: string | null;
  picked_up_at: string | null; delivered_at: string | null;
  payment_method: 'efectivo' | 'tarjeta'; driver_assigned: boolean; driver: { name: string; vehicle: string | null } | null;
  messages: number;
  items: { name: string; quantity: number; notes: string | null; modifiers: string[] }[];
}

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  nuevo: 'Nuevo', aceptado: 'En preparación', listo: 'Listo', en_camino: 'En camino',
  entregado: 'Entregado', rechazado: 'Rechazado', cancelado: 'Cancelado',
};

export const ACTIVE: DeliveryStatus[] = ['nuevo', 'aceptado', 'listo', 'en_camino'];

export const itemCount = (o: DeliveryOrder) => o.items.reduce((n, i) => n + i.quantity, 0);
