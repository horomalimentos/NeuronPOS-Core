export type EventStatus = 'borrador' | 'abierto' | 'cerrado' | 'terminado';
export interface SaleEvent {
  id: string; branch_id: string; branch_name: string; name: string; slug: string; place: string | null; description: string | null;
  sale_date: string; order_deadline: string | null; status: EventStatus; commission_pct: string; created_at: string;
  orders?: number; total?: string;
}
export interface EventProduct {
  id: string; name: string; description: string | null; price: string; image_url: string | null;
  max_quantity: number | null; sort_order: number; active: boolean; sold: number; left: number | null;
}
export interface EventOrder {
  id: string; folio: number; customer_name: string; customer_phone: string | null; notes: string | null;
  seller_id: string | null; seller_name: string | null; status: 'pendiente' | 'pagado' | 'cancelado'; total: string;
  paid_at: string | null; delivered_at: string | null; created_at: string; public_token: string;
  items: { product_id: string; name: string; price: string; quantity: number }[];
}
export const EVENT_STATUS: Record<EventStatus, [string, string]> = {
  borrador: ['Borrador', 'bg-gray-800 text-gray-300'],
  abierto: ['Abierto', 'bg-emerald-500/15 text-emerald-300'],
  cerrado: ['Pedidos cerrados', 'bg-amber-500/15 text-amber-300'],
  terminado: ['Terminado', 'bg-gray-800 text-gray-500'],
};
