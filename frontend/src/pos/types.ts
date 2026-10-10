// Tipos de la API del POS (/api/pos). Los montos llegan como string
// (NUMERIC de Postgres); se convierten con Number() al mostrarlos.
export type Money = string | number;

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  active: boolean;
}

export interface Modifier {
  id: string;
  group_id: string;
  name: string;
  price_delta: Money;
  sort_order: number;
  active: boolean;
}

export interface ModifierGroup {
  id: string;
  name: string;
  min_selections: number;
  max_selections: number | null;
  sort_order: number;
  active: boolean;
  modifiers: Modifier[];
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: Money;
  image_url: string | null;
  active: boolean;
  sort_order: number;
  modifier_group_ids: string[];
  unavailable_branch_ids: string[];
  available: boolean;
}

export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
  modifier_groups: ModifierGroup[];
}

export interface Zone {
  id: string;
  branch_id: string;
  name: string;
  sort_order: number;
  active: boolean;
}

export interface DiningTable {
  id: string;
  branch_id: string;
  zone_id: string | null;
  name: string;
  capacity: number;
  sort_order: number;
  active: boolean;
  status?: 'libre' | 'ocupada';
  order_id?: string | null;
  order_folio?: number | null;
  order_status?: OrderStatus | null;
  order_total?: Money | null;
  order_created_at?: string | null;
}

export type OrderType = 'comedor' | 'para_llevar' | 'domicilio';
export type OrderStatus = 'abierta' | 'enviada' | 'lista' | 'pagada' | 'cancelada';
// en_linea = "Clip en línea": lo registra el pago en línea del portal, nunca la caja.
export type MethodKind = 'efectivo' | 'tarjeta' | 'transferencia' | 'otro' | 'en_linea' | 'puntos' | 'monedero';

export interface OrderItemModifier {
  modifier_id: string | null;
  group_name: string;
  name: string;
  price_delta: Money;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string;
  name: string;
  unit_price: Money;
  modifiers_total: Money;
  quantity: number;
  line_total: Money;
  notes: string | null;
  sent_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  modifiers: OrderItemModifier[];
  is_new?: boolean;
}

export interface OrderPayment {
  id: string;
  payment_method_id: string;
  method_name: string;
  method_kind: MethodKind;
  amount: Money;
  tip: Money;
  received: Money;
  change_given: Money;
  reference: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  branch_id: string;
  folio: number;
  order_type: OrderType;
  table_id: string | null;
  table_name: string | null;
  guests: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  customer_id?: string | null;
  notes: string | null;
  status: OrderStatus;
  subtotal: Money;
  discount_type: 'amount' | 'percent' | null;
  discount_value: Money | null;
  discount_amount: Money;
  discount_reason: string | null;
  tax_rate_pct: Money;
  prices_include_tax: boolean;
  tax_amount: Money;
  total: Money;
  paid_amount: Money;
  tip_amount: Money;
  created_by_name: string | null;
  sent_at: string | null;
  ready_at: string | null;
  paid_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  items?: OrderItem[];
  payments?: OrderPayment[];
  // Pedidos en linea (source = 'web')
  source?: 'pos' | 'web';
  online_status?: OnlineStatus | null;
  delivery_fee?: Money;
  delivery_reference?: string | null;
  payment_preference?: 'efectivo' | 'tarjeta' | null;
  pay_with?: Money | null;
  accepted_at?: string | null;
  estimated_ready_at?: string | null;
  dispatched_at?: string | null;
  // Pago en linea con Clip: pendiente (no llega aqui), pagado o cancelado.
  payment_provider?: string | null;
  online_payment_status?: 'pendiente' | 'pagado' | 'cancelado' | null;
}

export type OnlineStatus = 'pendiente' | 'aceptada' | 'rechazada';

export interface PaymentMethod {
  id: string;
  name: string;
  kind: MethodKind;
  active: boolean;
  sort_order: number;
}

export interface PosSettings {
  tax_rate_pct: Money;
  prices_include_tax: boolean;
  cashier_max_discount_pct: Money;
  ticket_header: string | null;
  ticket_footer: string | null;
}

export interface CashSession {
  id: string;
  branch_id: string;
  branch_name: string;
  terminal: string;
  status: 'abierta' | 'cerrada';
  opening_cash: Money;
  opened_by_name: string;
  opened_at: string;
  expected_cash: Money | null;
  counted_cash: Money | null;
  difference: Money | null;
  total_sales: Money | null;
  total_tips: Money | null;
  orders_count: number | null;
  closed_by_name: string | null;
  closed_at: string | null;
  notes: string | null;
}

export interface CashMovement {
  id: string;
  kind: 'entrada' | 'salida';
  amount: Money;
  reason: string;
  created_at: string;
  created_by_name?: string;
}

export interface CutLine {
  payment_method_id: string;
  name: string;
  kind: MethodKind;
  payments: number;
  sales: number;
  tips: number;
  expected: number;
  counted?: number;
  difference?: number;
}

export interface CashCut {
  opening_cash: number;
  cash_in: number;
  cash_out: number;
  total_sales: number;
  total_tips: number;
  expected_cash: number;
  counted_cash?: number;
  cash_difference?: number;
  total_difference?: number;
  orders_count: number;
  methods: CutLine[];
}

export interface CashSessionDetail {
  session: CashSession;
  movements: CashMovement[];
  cut: CashCut;
}
