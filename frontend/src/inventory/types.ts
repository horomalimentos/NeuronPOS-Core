export interface InvUnit { id?: string; name: string; factor: number | string; is_purchase: boolean }

export interface InvProduct {
  id: string;
  name: string;
  category: string | null;
  base_unit: string;
  area_id: string | null;
  area_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  unit_cost: string;
  min_stock: string;
  daily_use: string;
  count_days: number[] | null;
  requires_photo: boolean;
  sort_order: number;
  active: boolean;
  units: InvUnit[];
}

export interface StockRow extends InvProduct {
  quantity: number;
  last_count_at: string | null;
  value: number;
  below_min: boolean;
  days_left: number | null;
  suggested: { unit: string; factor: number; quantity: number } | null;
}

export interface InvArea { id: string; name: string; sort_order: number; products: number }

export interface InvSupplier {
  id: string; name: string; contact_name: string | null; phone: string | null;
  email: string | null; notes: string | null; active: boolean; products: number;
}

export type MovementKind = 'conteo' | 'compra' | 'venta' | 'cancelacion' | 'merma' | 'ajuste';

export interface Movement {
  id: string; product_id: string; product_name: string; base_unit: string; kind: MovementKind;
  quantity: string; balance: string; unit_cost: string | null; reason: string | null;
  created_at: string; created_by_name: string | null;
}

export type CountStatus = 'en_progreso' | 'pausado' | 'completado' | 'cancelado';

export interface InvCount {
  id: string; branch_id: string; branch_name: string; area_id: string | null; area_name: string | null;
  count_date: string; status: CountStatus; notes: string | null; created_by_name: string | null;
  created_at: string; completed_at: string | null; completed_by_name: string | null; counted_items: number;
}

export interface CountItem {
  product_id: string; entered_quantity: string; entered_unit: string; quantity: string;
  expected: string | null; photo_url: string | null; counted_at: string; counted_by_name?: string | null;
}

export interface CountProduct extends InvProduct { scheduled: boolean; system_quantity: number; item: CountItem | null }

export type PoStatus = 'solicitada' | 'aprobada' | 'recibida' | 'cancelada';

export interface PoItem {
  id: string; product_id: string; name: string; base_unit: string; unit_name: string; unit_factor: string;
  quantity: string; unit_price: string; received_quantity: string | null;
}

export interface PurchaseOrder {
  id: string; folio: number; branch_id: string; branch_name: string; supplier_id: string | null;
  supplier_name: string | null; supplier_phone: string | null; status: PoStatus; notes: string | null;
  total: string; receipt_url: string | null; created_at: string; created_by_name: string | null;
  approved_at: string | null; approved_by_name: string | null; received_at: string | null;
  received_by_name: string | null; cancelled_reason: string | null; items_count: number; items?: PoItem[];
}

export interface Suggestion {
  supplier_id: string | null; supplier_name: string;
  items: {
    product_id: string; name: string; base_unit: string; stock: number; min_stock: number; daily_use: number;
    unit: string; factor: number; quantity: number; unit_price: number; units: InvUnit[];
  }[];
}

export interface RecipeLine { product_id: string; name: string; base_unit: string; quantity: string; unit_cost: string }

export interface RecipeDetail {
  item: { id: string; name: string; price: string; cost: number; cost_pct: number | null };
  lines: RecipeLine[];
  modifiers: { id: string; name: string; group_name: string; price_delta: string; general: RecipeLine[]; specific: RecipeLine[]; cost: number }[];
}

export interface InvSettings { deduct_on_sale: boolean; order_cover_days: number }
