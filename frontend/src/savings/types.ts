export type Frequency = 'diaria' | 'semanal' | 'quincenal' | 'mensual';
export type GoalStatus = 'activo' | 'completado' | 'cancelado';

export interface SavingsGoal {
  id: string; kind: 'libre' | 'aguinaldo'; scope: 'negocio' | 'personal'; branch_id: string | null; branch_name: string | null;
  owner_id: string; owner_name: string; name: string; description: string | null; color: string;
  target_amount: number; balance: number; missing: number; progress: number;
  frequency: Frequency | null; weekdays: number[]; start_date: string; due_date: string | null; days_left: number | null;
  aguinaldo_year: number | null; status: GoalStatus;
  installments_total: number; installments_done: number;
  next_installment: { id: string; due_on: string; amount: number | string } | null;
  access: 'manage' | 'edit' | 'view';
}

export interface Installment { id: string; due_on: string; amount: number | string; done: boolean; done_at: string | null; done_by_name: string | null }
export interface Movement {
  id: string; kind: 'deposito' | 'retiro'; amount: number | string; occurred_on: string; notes: string | null;
  created_by_name: string | null; installment_id: string | null;
}
export interface Share { user_id: string; name: string; role: string; can_edit: boolean }
export interface AguinaldoBreakdown {
  year: number; total: number;
  employees: { employee_id: string; full_name: string; branch_name: string; days_counted: number; daily_base: number; amount: number; paid: boolean }[];
}

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  diaria: 'Diaria', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual',
};
export const STATUS_LABEL: Record<GoalStatus, string> = { activo: 'Activo', completado: 'Completado', cancelado: 'Cancelado' };
export const WEEKDAYS = [
  { n: 1, label: 'L' }, { n: 2, label: 'M' }, { n: 3, label: 'M' }, { n: 4, label: 'J' }, { n: 5, label: 'V' }, { n: 6, label: 'S' }, { n: 7, label: 'D' },
];
export const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#64748B'];
