export type RestaurantStatus = 'active' | 'suspended' | 'trial';
export type Role = 'admin' | 'gerente' | 'cajero' | 'mesero' | 'cocina' | 'repartidor';

export interface Restaurant {
  id: string;
  slug: string;
  name: string;
  custom_domain: string | null;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  status: RestaurantStatus;
  trial_ends_at: string | null;
  // Fase 3: cobro
  suspended_reason?: 'falta_pago' | 'manual' | null;
  billing_day?: number | null;
  activated_at?: string | null;
  dunning_grace_until?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface RestaurantListItem extends Restaurant {
  branch_count: number;
  unpaid_invoices: number;
  has_overdue: boolean;
  monthly_total_mxn: number;
  enabled_modules: string[];
}

export interface CatalogModule {
  code: string;
  name: string;
  description: string;
  monthly_price_mxn: string;
  active: boolean;
  sort_order: number;
  enabled_restaurants?: number;
}

export interface RestaurantModule {
  module_code: string;
  name: string;
  description: string;
  monthly_price_mxn: string;
  catalog_active: boolean;
  enabled: boolean;
  custom_price_mxn: string | null;
  discount_pct: string;
  started_at: string | null;
  ends_at: string | null;
  is_active: boolean;
}

export interface DeliverySettings {
  mode: 'propio' | 'horom';
  horom_enabled: boolean;
  horom_fee_type: 'fixed' | 'percent';
  horom_fee_value: string;
}

export interface MonthlyCharge {
  total_mxn: number;
  lines: { module_code: string; name: string; amount_mxn: number }[];
}

export interface RestaurantDetail {
  restaurant: Restaurant;
  modules: RestaurantModule[];
  delivery: DeliverySettings;
  monthly: MonthlyCharge;
  counts: { branches: number; users: number };
  invoices: Invoice[];
}

// ---------------------------------------------------------------------------
// Cobro de la suscripcion (fase 3)
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'pending' | 'overdue' | 'paid' | 'void';

export interface InvoiceItem {
  module_code: string;
  name: string;
  catalog_price_mxn: string;
  custom_price_mxn: string | null;
  unit_price_mxn: string;
  discount_pct: string;
  discount_mxn: string;
  amount_mxn: string;
}

export interface Invoice {
  id: string;
  restaurant_id: string;
  restaurant_name: string;
  restaurant_slug: string;
  restaurant_status: RestaurantStatus;
  period: string;
  period_end: string;
  due_date: string;
  suspends_on: string | null;
  subtotal_mxn: string;
  discount_mxn: string;
  amount_mxn: string;
  status: InvoiceStatus;
  paid_at: string | null;
  paid_method: 'clip' | 'manual' | 'sin_cargo' | null;
  paid_reference: string | null;
  paid_note: string | null;
  last_sent_at: string | null;
  created_at: string;
  payment_url: string | null;
  payment_link_status: string | null;
  payment_link_expires_at: string | null;
  items?: InvoiceItem[];
}

export interface BillingSummary {
  grace_days: number;
  unpaid_count: number;
  unpaid_total_mxn: number;
  overdue: boolean;
  next_invoice: {
    id: string; amount_mxn: string; due_date: string; status: InvoiceStatus; suspends_on: string | null; payment_url: string | null;
  } | null;
  suspended_for_nonpayment: boolean;
}

export interface PlatformSettings {
  grace_days: number;
  billing_auto: boolean;
  billing_timezone: string;
  clip: { configured: boolean; webhook_secret_configured: boolean; webhook_url: string; restaurant_webhook_url_example: string };
  secrets_key_configured: boolean;
}

/** Pago en línea con Clip del restaurante: nunca trae las credenciales. */
export interface OnlinePayments {
  clip: { configured: boolean; webhook_secret_configured: boolean; webhook_url: string | null };
  online_payment_enabled: boolean;
  payment_timeout_minutes: number;
  secrets_key_configured: boolean;
  available: boolean;
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  active: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  branch_ids: string[];
  last_login_at?: string | null;
}

export interface MeModule {
  code: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface Me {
  user: { id: string; email: string; name: string; role: Role; branch_ids: string[] };
  restaurant: Restaurant & { access_error: { code: string; error: string } | null };
  modules: MeModule[];
  branches: Branch[];
  /** Solo admin y gerente (null para el resto). */
  billing: BillingSummary | null;
}

export interface BranchHours {
  weekday: number;
  opens_at: string;
  closes_at: string;
}

export interface BranchClosure {
  closed_on: string;
  reason: string | null;
}

/** Sucursal tal como la ve el publico (sitio y portal). */
export interface PublicBranch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  maps_url: string | null;
  hours: BranchHours[];
  closures: BranchClosure[];
  open_now: boolean;
  today: { opens_at: string; closes_at: string } | null;
  closed_today: boolean;
}

export interface PublicSite {
  restaurant: {
    slug: string;
    name: string;
    logo_url: string | null;
    primary_color: string;
    secondary_color: string;
    available: boolean;
  };
  modules: string[];
  ordering: boolean;
  seo: { title: string; description: string | null };
  branches: PublicBranch[];
}
