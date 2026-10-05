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
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface RestaurantListItem extends Restaurant {
  branch_count: number;
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
  invoices: { id: string; period: string; amount_mxn: string; status: string }[];
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
  branches: { name: string; address: string | null; phone: string | null }[];
}
