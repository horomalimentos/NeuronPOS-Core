// Tipos del sitio publico (/api/public) y del portal de clientes
// (/api/portal). Los montos llegan como string (NUMERIC de Postgres).
import type { PublicBranch } from '../lib/types';

export type Money = string | number;

export interface SiteContent {
  hero_title?: string;
  hero_subtitle?: string;
  hero_image_url?: string;
  announcement?: string;
  about_title?: string;
  about_text?: string;
  about_image_url?: string;
  show_menu?: boolean;
  menu_title?: string;
  show_gallery?: boolean;
  gallery_title?: string;
  contact_email?: string;
  whatsapp?: string;
  social_facebook?: string;
  social_instagram?: string;
  social_tiktok?: string;
  social_x?: string;
  social_website?: string;
  footer_text?: string;
  seo_title?: string;
  seo_description?: string;
}

export interface GalleryImage {
  id: string;
  image_url: string;
  caption: string | null;
  sort_order?: number;
}

export interface LandingData {
  restaurant: { slug: string; name: string; logo_url: string | null; primary_color: string; secondary_color: string };
  content: SiteContent;
  gallery: GalleryImage[];
  menu: {
    id: string;
    name: string;
    description: string | null;
    items: { id: string; name: string; description: string | null; price: Money; image_url: string | null }[];
  }[];
  branches: PublicBranch[];
  ordering: boolean;
}

export interface PortalBranch extends PublicBranch {
  accepts_orders: boolean;
  delivery_available: boolean;
  delivery_fee: Money;
}

export interface PaymentOption {
  code: 'contra_entrega' | 'clip' | 'monedero';
  name: string;
  /** true = se paga en linea antes de que el restaurante lo prepare. */
  online: boolean;
  methods: { code: string; name: string }[];
  /** Pide sesion del cliente (monedero). */
  needs_customer?: boolean;
}

/** Lo que regresa POST /portal/orders: a donde mandar al cliente para pagar. */
export interface PaymentStart {
  action: 'none' | 'redirect';
  url?: string;
}

export interface PortalConfig {
  restaurant: LandingData['restaurant'];
  ordering_available: boolean;
  settings: { min_order: Money; prep_time_minutes: number; allow_pickup: boolean; allow_delivery: boolean };
  branches: PortalBranch[];
  payment_options: PaymentOption[];
}

export interface PortalModifier {
  id: string;
  group_id: string;
  name: string;
  price_delta: Money;
}

export interface PortalModifierGroup {
  id: string;
  name: string;
  min_selections: number;
  max_selections: number | null;
  modifiers: PortalModifier[];
}

export interface PortalItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: Money;
  image_url: string | null;
  modifier_group_ids: string[];
  available: boolean;
}

export interface PortalMenu {
  categories: { id: string; name: string; description: string | null }[];
  items: PortalItem[];
  modifier_groups: PortalModifierGroup[];
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string | null;
}

export interface Address {
  id: string;
  label: string;
  address: string;
  reference: string | null;
}

export type CustomerStatus = 'esperando_pago' | 'recibido' | 'preparando' | 'listo' | 'en_camino' | 'entregado' | 'rechazado' | 'cancelado';

export interface CustomerOrder {
  id: string;
  token: string;
  folio: number;
  branch: { id: string; name?: string; address?: string | null; phone?: string | null };
  order_type: 'para_llevar' | 'domicilio';
  status: CustomerStatus;
  status_label: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  delivery_reference: string | null;
  notes: string | null;
  payment_preference: 'efectivo' | 'tarjeta' | null;
  pay_with: Money | null;
  payment_provider: string | null;
  online_payment_status: 'pendiente' | 'pagado' | 'cancelado' | null;
  payment_due_at: string | null;
  items: {
    name: string;
    quantity: number;
    unit_price: Money;
    modifiers_total: Money;
    line_total: Money;
    notes: string | null;
    modifiers: { group_name: string; name: string; price_delta: Money }[];
  }[];
  subtotal: Money;
  discount_amount: Money;
  tax_amount: Money;
  tax_rate_pct: Money;
  prices_include_tax: boolean;
  delivery_fee: Money;
  total: Money;
  paid: boolean;
  cancel_reason: string | null;
  created_at: string;
  accepted_at: string | null;
  estimated_ready_at: string | null;
  ready_at: string | null;
  dispatched_at: string | null;
  paid_at: string | null;
  /** Reparto a domicilio (fase 5); la ubicacion solo llega en camino. */
  delivery?: CustomerDelivery | null;
}

export interface CustomerDelivery {
  status: 'solicitado' | 'asignado' | 'recogido' | 'en_camino' | 'entregado' | 'fallido' | 'cancelado';
  status_label: string;
  driver_name: string | null;
  fail_reason: string | null;
  on_way_at: string | null;
  delivered_at: string | null;
  location: { latitude: number; longitude: number; updated_at: string } | null;
}

export interface Quote {
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  delivery_fee: number;
  total: number;
  tax_rate_pct: Money;
  prices_include_tax: boolean;
  prep_time_minutes: number;
  items: { menu_item_id: string; name: string; quantity: number; line_total: number }[];
}
