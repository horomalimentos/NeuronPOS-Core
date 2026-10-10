export interface LoyaltyCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  has_account: boolean;
  points_balance: number;
  points_earned: number;
  points_redeemed: number;
  points_value: number;
  code_locked: boolean;
  orders: number;
  spent: number;
  last_order_at: string | null;
}

export interface LoyaltySettings {
  program_name: string;
  earn_enabled: boolean;
  redeem_enabled: boolean;
  points_per_peso: number;
  peso_per_point: number;
  min_redeem_points: number;
  max_points_per_order: number | null;
  require_code: boolean;
  earn_on_web: boolean;
}

export type LoyaltyKind = 'earn' | 'redeem' | 'reverse' | 'adjust';

export interface LoyaltyTransaction {
  id: string; kind: LoyaltyKind; points: number; balance_after: number; amount: string | null;
  order_id: string | null; reason: string | null; created_at: string; created_by_name: string | null;
}

export interface CustomerOrder {
  id: string; folio: number; branch_name: string; order_type: string; source: 'pos' | 'web'; status: string;
  total: string; created_at: string; paid_at: string | null; points_earned: number | null; points_redeemed: number | null;
}

export interface CustomerDetail { customer: LoyaltyCustomer; orders: CustomerOrder[]; transactions: LoyaltyTransaction[] }

export const KIND_LABEL: Record<LoyaltyKind, string> = {
  earn: 'Compra', redeem: 'Canje', reverse: 'Devolución', adjust: 'Ajuste',
};

export const fmtPoints = (n: number) => n.toLocaleString('es-MX');
