// Tipos de recursos humanos, nomina y empleado del mes (respuestas de /api/employees, /api/rh y /api/recognition).
import type { Role } from '../lib/types';

export type Money = string;
export type PayType = 'diario' | 'por_hora';
export type Frequency = 'semanal' | 'quincenal' | 'mensual';

export interface ScheduleDay {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export interface Employee {
  id: string;
  user_id: string | null;
  branch_id: string;
  branch_name: string;
  timezone: string;
  area_id: string | null;
  area_name: string | null;
  full_name: string;
  employee_number: string | null;
  position: string | null;
  pay_type: PayType;
  daily_salary: Money;
  hourly_rate: Money;
  payment_frequency: Frequency;
  hire_date: string;
  termination_date: string | null;
  active: boolean;
  nss: string | null;
  rfc: string | null;
  curp: string | null;
  phone: string | null;
  email: string | null;
  bank_name: string | null;
  bank_account: string | null;
  notes: string | null;
  has_pin: boolean;
  user_name: string | null;
  user_email: string | null;
  user_role: Role | null;
  schedule?: ScheduleDay[];
}

export interface Area {
  id: string;
  name: string;
  active: boolean;
  employees?: number;
}

export interface PayrollSettings {
  week_start_day: number;
  daily_hours: string;
  tolerance_minutes: number;
  tardiness_penalty: Money;
  tardiness_proportional: boolean;
  absence_penalty: Money;
  pay_rest_days: boolean;
  overtime_enabled: boolean;
  overtime_block_minutes: number;
  overtime_double_weekly_hours: number;
  overtime_double_factor: string;
  overtime_triple_factor: string;
  holiday_worked_factor: string;
  rest_day_worked_factor: string;
  sunday_premium_pct: string;
  official_holidays: boolean;
  punctuality_bonus: Money;
  attendance_bonus: Money;
  aguinaldo_days: number;
}

export interface ClockSettings {
  branch_id: string;
  branch_name: string;
  geo_enabled: boolean;
  latitude: string | null;
  longitude: string | null;
  radius_meters: number;
  allowed_ips: string[];
}

export interface Holiday {
  date: string;
  name: string;
}

export interface TimeEntry {
  id: string;
  employee_id: string;
  employee_name: string;
  branch_id: string;
  branch_name: string;
  timezone: string;
  kind: 'entrada' | 'salida';
  occurred_at: string;
  source: 'kiosco' | 'manual' | 'importado';
  voided: boolean;
  created_by_name: string | null;
  corrections: number;
}

export interface AuditRow {
  id: string;
  action: 'crear' | 'editar' | 'anular';
  reason: string;
  before: { kind: string; occurred_at: string; voided: boolean } | null;
  after: { kind: string; occurred_at: string; voided: boolean } | null;
  created_at: string;
  user_name: string;
}

export type DayStatus = 'trabajado' | 'falta' | 'falta_justificada' | 'descanso' | 'festivo' | 'pendiente' | 'fuera_de_contrato';

export interface AttendanceDay {
  date: string;
  dow: number;
  type: 'laboral' | 'descanso' | 'festivo';
  status: DayStatus;
  holiday_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  first_in: string | null;
  minutes_worked: number;
  late_minutes: number;
  tardy: boolean;
  tardy_justified: boolean;
  overtime_minutes: number;
  incomplete: boolean;
  note: string | null;
}

export interface AttendanceSummary {
  days_scheduled: number;
  days_worked: number;
  absences: number;
  absences_justified: number;
  tardies: number;
  tardies_justified: number;
  minutes_worked: number;
  incomplete: number;
}

export interface EmployeeAttendance {
  employee_id: string;
  full_name: string;
  position: string | null;
  branch_id: string;
  branch_name: string;
  summary: AttendanceSummary;
  days: AttendanceDay[];
}

export interface Adjustment {
  id: string;
  employee_id: string;
  employee_name: string;
  kind: 'bono' | 'descuento' | 'prestamo';
  concept: string;
  amount: Money;
  recurrence: 'unico' | 'cada_periodo';
  apply_date: string | null;
  start_date: string | null;
  end_date: string | null;
  total_amount: Money | null;
  active: boolean;
  source: 'manual' | 'empleado_mes';
  notes: string | null;
  applied_amount: Money;
}

export type PeriodStatus = 'borrador' | 'aprobada' | 'cerrada';

export interface PayrollPeriod {
  id: string;
  frequency: Frequency;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
  employees_count: number;
  total_gross: Money;
  total_deductions: Money;
  total_net: Money;
  calculated_at: string | null;
  approved_at: string | null;
  closed_at: string | null;
  calculated_by_name: string | null;
  approved_by_name: string | null;
  closed_by_name: string | null;
  paid_count?: number;
  signed_count?: number;
}

export interface PayrollLine {
  kind: 'percepcion' | 'deduccion';
  code: string;
  concept: string;
  amount: Money;
}

export interface PayrollItem {
  id: string;
  period_id: string;
  employee_id: string;
  branch_name: string;
  employee_name: string;
  position: string | null;
  pay_type: PayType;
  daily_salary: Money;
  hourly_rate: Money;
  days_scheduled: number;
  days_worked: number;
  days_paid: string;
  rest_days_paid: number;
  holidays: number;
  holidays_worked: number;
  absences: number;
  absences_justified: number;
  tardies: number;
  tardy_minutes: number;
  minutes_worked: number;
  overtime_minutes_double: number;
  overtime_minutes_triple: number;
  gross: Money;
  deductions: Money;
  net: Money;
  paid_at: string | null;
  paid_method: 'caja' | 'efectivo' | 'transferencia' | 'otro' | null;
  paid_by_name: string | null;
  signed_at: string | null;
  net_at_signing: Money | null;
  lines: PayrollLine[];
  detail?: AttendanceDay[];
  // Recibos del empleado
  frequency?: Frequency;
  start_date?: string;
  end_date?: string;
  period_status?: PeriodStatus;
}

export interface MyEmployee {
  id: string;
  full_name: string;
  employee_number: string | null;
  position: string | null;
  area_name: string | null;
  branch_name: string;
  timezone: string;
  pay_type: PayType;
  payment_frequency: Frequency;
  hire_date: string;
  has_pin: boolean;
  schedule: ScheduleDay[];
}

export interface KioskEmployee {
  id: string;
  full_name: string;
  position: string | null;
  inside: boolean;
  last_at: string | null;
}

// --- Empleado del mes ---

export interface RecognitionSettings {
  weight_attendance: number;
  weight_punctuality: number;
  weight_sales: number;
  weight_evaluation: number;
  weight_tasks: number;
  min_days_worked: number;
  prize_text: string | null;
  prize_amount: Money;
  prize_to_payroll: boolean;
  auto_close: boolean;
}

export interface RankingComponents {
  attendance: number | null;
  punctuality: number | null;
  sales: number | null;
  evaluation: number | null;
  tasks: number | null;
}

export interface RankingRow {
  employee_id: string;
  employee_name: string;
  position: string | null;
  branch_id: string;
  branch_name: string;
  rank: number;
  score: number;
  is_winner: boolean;
  components?: RankingComponents & { days_worked?: number | null; sales?: number | null; task_points?: number };
  days_worked?: number | null;
  sales?: number | null;
  task_points?: number;
  adjustment_id?: string | null;
}

export interface MonthRanking {
  year: number;
  month: number;
  closed: boolean;
  closed_at?: string;
  prize_text: string | null;
  prize_amount: Money;
  modules?: { rh: boolean; pos: boolean };
  ranking: RankingRow[];
}

export interface Evaluation {
  id: string;
  employee_id: string;
  employee_name: string;
  score: number;
  comment: string | null;
  evaluator_id: string;
  evaluator_name: string;
}

export interface RecognitionTask {
  id: string;
  employee_id: string;
  employee_name: string;
  title: string;
  description: string | null;
  points: number;
  due_date: string | null;
  status: 'pendiente' | 'completada' | 'cancelada';
  completed_at: string | null;
  verified_by_name: string | null;
}

export interface HistoryMonth {
  year: number;
  month: number;
  closed_at: string;
  prize_text: string | null;
  prize_amount: Money;
  closed_by_name: string | null;
  winners: { employee_id: string; employee_name: string; branch_name: string; score: string; adjustment_id: string | null }[];
}

export interface Wall {
  winners: RankingRow[];
  winners_month: { year: number; month: number } | null;
  prize_text: string | null;
  current: { year: number; month: number; ranking: RankingRow[] };
}

// --- Turnos y rol semanal (modulo turnos) ---

export interface ShiftTemplate {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  color: string;
  active: boolean;
}

/** Un dia del rol: 'rol' = asignado, 'fijo' = su horario semanal, null = sin horario. */
export interface RosterDay {
  date: string;
  source: 'rol' | 'fijo' | null;
  shift_id: string | null;
  shift_name: string | null;
  color: string | null;
  is_rest: boolean;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
  outside: boolean;
}

export interface RosterEmployee {
  id: string;
  full_name: string;
  position: string | null;
  area_name: string | null;
  branch_id: string;
  branch_name: string;
  days: RosterDay[];
}

export interface RosterWeek {
  start: string;
  end: string;
  dates: string[];
  employees: RosterEmployee[];
  templates: ShiftTemplate[];
}

// --- Prenomina en vivo, aclaraciones y aguinaldo ---

export interface LiveItem {
  employee_id: string;
  full_name: string;
  position: string | null;
  branch_name: string;
  frequency: Frequency;
  start_date: string;
  end_date: string;
  period_status: PeriodStatus | null;
  no_salary?: boolean;
  days_worked?: number;
  absences?: number;
  tardies?: number;
  minutes_worked?: number;
  gross?: number;
  deductions?: number;
  net?: number;
  lines?: { kind: 'percepcion' | 'deduccion'; code: string; concept: string; amount: number }[];
  days?: { date: string; type: string; status: DayStatus; shift_name: string | null; scheduled_start: string | null; scheduled_end: string | null; first_in: string | null; late_minutes: number; tardy: boolean }[];
}

export type ClaimKind = 'falta' | 'retardo' | 'horas' | 'pago' | 'descuento' | 'otro';
export type ClaimStatus = 'pendiente' | 'resuelta' | 'rechazada';

export interface PayrollClaim {
  id: string;
  employee_id: string;
  employee_name: string;
  item_id: string | null;
  date: string | null;
  kind: ClaimKind;
  description: string;
  amount: Money | null;
  status: ClaimStatus;
  response: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
}

export interface AguinaldoRow {
  employee_id: string;
  full_name: string;
  position: string | null;
  branch_name: string;
  hire_date: string;
  termination_date: string | null;
  active: boolean;
  days_counted: number;
  proportional: boolean;
  daily_base: number;
  aguinaldo_days: number;
  amount: number;
  payment: { id: string; amount: Money; method: string; paid_at: string; paid_by_name: string | null; notes: string | null } | null;
}
