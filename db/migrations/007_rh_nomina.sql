-- 007: Recursos humanos, nomina y empleado del mes (Fase 4).
--
-- Modulo 'rh':
--   - hr_areas, employees (con o sin usuario del sistema), employee_schedules
--     (horario semanal; sin fila = dia de descanso).
--   - hr_clock_settings: restriccion del checador por sucursal (geocerca e IPs).
--   - time_entries (checadas) y time_entry_audit (correcciones manuales con
--     motivo: quien, cuando, antes y despues).
--   - attendance_justifications: retardos y faltas justificados.
--   - payroll_settings (reglas de nomina del restaurante), hr_holidays (dias
--     de descanso adicionales; los oficiales de Mexico se calculan por regla,
--     ver mx_official_holiday()).
--   - payroll_adjustments: bonos, descuentos y prestamos manuales.
--   - payroll_periods, payroll_items (un recibo por empleado y periodo),
--     payroll_item_lines (percepciones y deducciones) y
--     payroll_receipt_signatures (aceptacion del recibo por el empleado).
-- Modulo 'empleado_mes':
--   - recognition_settings (pesos y premio), recognition_evaluations
--     (evaluacion manual del gerente), recognition_tasks, recognition_months
--     (mes cerrado) y recognition_results (ranking guardado y ganadores).
--
-- Mismas reglas que 004-006: restaurant_id en cada tabla, UNIQUE
-- (restaurant_id, id), llaves foraneas compuestas para que nada apunte a otro
-- restaurante y RLS (FORCE) con la politica de 003. Montos en numeric(10,2);
-- los calculos se hacen en centavos (backend/services/rh/payrollMath.js).

-- ---------------------------------------------------------------------------
-- Empleados
-- ---------------------------------------------------------------------------

CREATE TABLE hr_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Usuario del sistema (opcional): con el ve sus checadas y recibos.
  user_id           uuid,
  branch_id         uuid NOT NULL,
  area_id           uuid,
  full_name         text NOT NULL,
  -- Numero de empleado (opcional, unico por restaurante): lo usa la
  -- importacion de checadas de otros relojes.
  employee_number   text,
  position          text,
  -- diario = salario diario; por_hora = tarifa por hora trabajada.
  pay_type          text NOT NULL DEFAULT 'diario' CHECK (pay_type IN ('diario', 'por_hora')),
  daily_salary      numeric(10,2) NOT NULL DEFAULT 0 CHECK (daily_salary >= 0),
  hourly_rate       numeric(10,2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  payment_frequency text NOT NULL DEFAULT 'semanal' CHECK (payment_frequency IN ('semanal', 'quincenal', 'mensual')),
  hire_date         date NOT NULL DEFAULT current_date,
  termination_date  date,
  active            boolean NOT NULL DEFAULT true,
  -- Datos opcionales del expediente.
  nss               text,
  rfc               text,
  curp              text,
  phone             text,
  email             text,
  bank_name         text,
  bank_account      text,
  notes             text,
  -- NIP del checador (bcrypt). Bloqueo tras varios intentos fallidos.
  pin_hash          text,
  pin_failed_attempts integer NOT NULL DEFAULT 0,
  pin_locked_until  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, user_id),
  UNIQUE (restaurant_id, employee_number),
  CHECK (termination_date IS NULL OR termination_date >= hire_date),
  FOREIGN KEY (restaurant_id, user_id)   REFERENCES users (restaurant_id, id)    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, area_id)   REFERENCES hr_areas (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX employees_branch_idx ON employees (restaurant_id, branch_id);

-- Horario semanal. day_of_week: 0 = domingo ... 6 = sabado. Si end_time <=
-- start_time el turno termina al dia siguiente.
CREATE TABLE employee_schedules (
  restaurant_id uuid NOT NULL,
  employee_id   uuid NOT NULL,
  day_of_week   smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  PRIMARY KEY (employee_id, day_of_week),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX employee_schedules_restaurant_idx ON employee_schedules (restaurant_id);

-- ---------------------------------------------------------------------------
-- Checador
-- ---------------------------------------------------------------------------

CREATE TABLE hr_clock_settings (
  restaurant_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  -- Geocerca: si esta activa, el kiosco debe mandar ubicacion dentro del radio.
  geo_enabled   boolean NOT NULL DEFAULT false,
  latitude      numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude     numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  radius_meters integer NOT NULL DEFAULT 150 CHECK (radius_meters BETWEEN 10 AND 100000),
  -- IPs o rangos IPv4 (CIDR) desde donde se permite checar. Vacio = cualquiera.
  allowed_ips   text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  CHECK (NOT geo_enabled OR (latitude IS NOT NULL AND longitude IS NOT NULL))
);
CREATE INDEX hr_clock_settings_restaurant_idx ON hr_clock_settings (restaurant_id);

CREATE TABLE time_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  branch_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('entrada', 'salida')),
  occurred_at   timestamptz NOT NULL,
  -- kiosco = checador; manual = captura/correccion de un gerente;
  -- importado = otro reloj checador (services/rh/clockImport.js).
  source        text NOT NULL DEFAULT 'kiosco' CHECK (source IN ('kiosco', 'manual', 'importado')),
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  ip            text,
  -- Identificador del evento en el reloj externo (evita importar dos veces).
  external_id   text,
  voided        boolean NOT NULL DEFAULT false,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, source, external_id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)   REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX time_entries_employee_idx ON time_entries (restaurant_id, employee_id, occurred_at);
CREATE INDEX time_entries_branch_idx ON time_entries (restaurant_id, branch_id, occurred_at);

-- Bitacora de correcciones manuales (crear, editar, anular). Nunca se borra.
CREATE TABLE time_entry_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  time_entry_id uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('crear', 'editar', 'anular')),
  reason        text NOT NULL,
  before        jsonb,
  after         jsonb,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, time_entry_id) REFERENCES time_entries (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, user_id)       REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX time_entry_audit_entry_idx ON time_entry_audit (restaurant_id, time_entry_id);

-- Retardo o falta justificado (no se descuenta). with_pay = permiso con goce
-- de sueldo (la falta se paga como dia trabajado).
CREATE TABLE attendance_justifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  date          date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('retardo', 'falta')),
  note          text NOT NULL,
  with_pay      boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (employee_id, date, kind),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX attendance_justifications_idx ON attendance_justifications (restaurant_id, employee_id, date);

-- ---------------------------------------------------------------------------
-- Configuracion de nomina
-- ---------------------------------------------------------------------------

CREATE TABLE payroll_settings (
  restaurant_id              uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Dia en que empieza la semana de nomina (0 = domingo, 1 = lunes...).
  week_start_day             smallint NOT NULL DEFAULT 1 CHECK (week_start_day BETWEEN 0 AND 6),
  -- Horas de la jornada (salario diario / horas = tarifa por hora).
  daily_hours                numeric(4,2) NOT NULL DEFAULT 8 CHECK (daily_hours > 0 AND daily_hours <= 24),
  -- Minutos de tolerancia antes de contar retardo.
  tolerance_minutes          integer NOT NULL DEFAULT 10 CHECK (tolerance_minutes BETWEEN 0 AND 240),
  -- Descuento por retardo: monto fijo y/o los minutos no trabajados.
  tardiness_penalty          numeric(10,2) NOT NULL DEFAULT 0 CHECK (tardiness_penalty >= 0),
  tardiness_proportional     boolean NOT NULL DEFAULT true,
  -- Descuento adicional por falta injustificada (el dia ya no se paga).
  absence_penalty            numeric(10,2) NOT NULL DEFAULT 0 CHECK (absence_penalty >= 0),
  -- Descanso semanal pagado (septimo dia) para salario diario.
  pay_rest_days              boolean NOT NULL DEFAULT true,
  -- Horas extra: minutos por encima del turno, en bloques. Las primeras
  -- overtime_double_weekly_hours de cada semana se pagan dobles y el resto
  -- triples (LFT art. 67 y 68).
  overtime_enabled           boolean NOT NULL DEFAULT true,
  overtime_block_minutes     integer NOT NULL DEFAULT 30 CHECK (overtime_block_minutes BETWEEN 1 AND 120),
  overtime_double_weekly_hours integer NOT NULL DEFAULT 9 CHECK (overtime_double_weekly_hours BETWEEN 0 AND 60),
  overtime_double_factor     numeric(4,2) NOT NULL DEFAULT 2 CHECK (overtime_double_factor >= 1),
  overtime_triple_factor     numeric(4,2) NOT NULL DEFAULT 3 CHECK (overtime_triple_factor >= 1),
  -- Dia festivo oficial: se paga aunque no se trabaje; si se trabaja se paga
  -- ademas este factor del salario (2 = salario doble adicional, LFT art. 75).
  holiday_worked_factor      numeric(4,2) NOT NULL DEFAULT 2 CHECK (holiday_worked_factor >= 0),
  -- Descanso laborado: factor adicional (LFT art. 73).
  rest_day_worked_factor     numeric(4,2) NOT NULL DEFAULT 2 CHECK (rest_day_worked_factor >= 0),
  -- Prima dominical (% del salario del dia, LFT art. 71).
  sunday_premium_pct         numeric(5,2) NOT NULL DEFAULT 25 CHECK (sunday_premium_pct BETWEEN 0 AND 100),
  -- Usar los dias de descanso obligatorio oficiales de Mexico.
  official_holidays          boolean NOT NULL DEFAULT true,
  -- Bonos por periodo: puntualidad (sin retardos) y asistencia (sin faltas).
  punctuality_bonus          numeric(10,2) NOT NULL DEFAULT 0 CHECK (punctuality_bonus >= 0),
  attendance_bonus           numeric(10,2) NOT NULL DEFAULT 0 CHECK (attendance_bonus >= 0),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Dias de descanso adicionales del restaurante (los oficiales se calculan).
CREATE TABLE hr_holidays (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  date          date NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, date)
);

-- Dias de descanso obligatorio de Mexico (LFT art. 74), por regla: sirve para
-- cualquier anio. Mismo calculo que backend/services/rh/holidays.js.
CREATE OR REPLACE FUNCTION mx_official_holiday(p_date date) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  y integer := extract(year FROM p_date)::integer;
  first_mon_feb date := make_date(y, 2, 1) + ((8 - extract(isodow FROM make_date(y, 2, 1))::integer) % 7);
  third_mon_mar date := make_date(y, 3, 1) + ((8 - extract(isodow FROM make_date(y, 3, 1))::integer) % 7) + 14;
  third_mon_nov date := make_date(y, 11, 1) + ((8 - extract(isodow FROM make_date(y, 11, 1))::integer) % 7) + 14;
BEGIN
  IF p_date = make_date(y, 1, 1) THEN RETURN 'Año Nuevo'; END IF;
  IF p_date = first_mon_feb THEN RETURN 'Día de la Constitución'; END IF;
  IF p_date = third_mon_mar THEN RETURN 'Natalicio de Benito Juárez'; END IF;
  IF p_date = make_date(y, 5, 1) THEN RETURN 'Día del Trabajo'; END IF;
  IF p_date = make_date(y, 9, 16) THEN RETURN 'Día de la Independencia'; END IF;
  IF p_date = third_mon_nov THEN RETURN 'Día de la Revolución'; END IF;
  IF p_date = make_date(y, 12, 25) THEN RETURN 'Navidad'; END IF;
  IF p_date = make_date(y, 10, 1) AND (y - 2024) % 6 = 0 THEN RETURN 'Transmisión del Poder Ejecutivo Federal'; END IF;
  RETURN NULL;
END
$$;

-- Bonos, descuentos y prestamos manuales.
--   unico: se aplica en el periodo que contiene apply_date.
--   cada_periodo: en cada periodo entre start_date y end_date (o sin fin).
--   prestamo: total_amount es lo prestado; amount es el abono por periodo y
--   se deja de descontar al cubrir el total.
CREATE TABLE payroll_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('bono', 'descuento', 'prestamo')),
  concept       text NOT NULL,
  amount        numeric(10,2) NOT NULL CHECK (amount > 0),
  recurrence    text NOT NULL DEFAULT 'unico' CHECK (recurrence IN ('unico', 'cada_periodo')),
  apply_date    date,
  start_date    date,
  end_date      date,
  total_amount  numeric(10,2) CHECK (total_amount IS NULL OR total_amount > 0),
  active        boolean NOT NULL DEFAULT true,
  -- Origen: manual o empleado_mes (premio del mes).
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'empleado_mes')),
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK (recurrence <> 'unico' OR apply_date IS NOT NULL),
  CHECK (recurrence <> 'cada_periodo' OR start_date IS NOT NULL),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CHECK (kind <> 'prestamo' OR total_amount IS NOT NULL),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX payroll_adjustments_employee_idx ON payroll_adjustments (restaurant_id, employee_id);

-- ---------------------------------------------------------------------------
-- Prenomina / periodos de nomina
-- ---------------------------------------------------------------------------

-- borrador (se puede recalcular) -> aprobada (el empleado firma; se paga)
-- -> cerrada. Un periodo por frecuencia y fecha de inicio (idempotente).
CREATE TABLE payroll_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  frequency       text NOT NULL CHECK (frequency IN ('semanal', 'quincenal', 'mensual')),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'aprobada', 'cerrada')),
  employees_count integer NOT NULL DEFAULT 0,
  total_gross     numeric(12,2) NOT NULL DEFAULT 0,
  total_deductions numeric(12,2) NOT NULL DEFAULT 0,
  total_net       numeric(12,2) NOT NULL DEFAULT 0,
  calculated_at   timestamptz,
  calculated_by   uuid,
  approved_at     timestamptz,
  approved_by     uuid,
  closed_at       timestamptz,
  closed_by       uuid,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, frequency, start_date),
  CHECK (end_date >= start_date),
  FOREIGN KEY (restaurant_id, calculated_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, approved_by)   REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, closed_by)     REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);

-- Recibo de un empleado en un periodo (datos copiados al calcular).
CREATE TABLE payroll_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  period_id          uuid NOT NULL,
  employee_id        uuid NOT NULL,
  branch_id          uuid NOT NULL,
  employee_name      text NOT NULL,
  position           text,
  pay_type           text NOT NULL,
  daily_salary       numeric(10,2) NOT NULL,
  hourly_rate        numeric(10,2) NOT NULL,
  days_scheduled     integer NOT NULL DEFAULT 0,
  days_worked        integer NOT NULL DEFAULT 0,
  days_paid          numeric(6,2) NOT NULL DEFAULT 0,
  rest_days_paid     integer NOT NULL DEFAULT 0,
  holidays           integer NOT NULL DEFAULT 0,
  holidays_worked    integer NOT NULL DEFAULT 0,
  absences           integer NOT NULL DEFAULT 0,
  absences_justified integer NOT NULL DEFAULT 0,
  tardies            integer NOT NULL DEFAULT 0,
  tardy_minutes      integer NOT NULL DEFAULT 0,
  minutes_worked     integer NOT NULL DEFAULT 0,
  overtime_minutes_double integer NOT NULL DEFAULT 0,
  overtime_minutes_triple integer NOT NULL DEFAULT 0,
  gross              numeric(10,2) NOT NULL DEFAULT 0,
  deductions         numeric(10,2) NOT NULL DEFAULT 0,
  net                numeric(10,2) NOT NULL DEFAULT 0,
  -- Desglose por dia (para revisar la prenomina).
  detail             jsonb NOT NULL DEFAULT '[]'::jsonb,
  paid_at            timestamptz,
  paid_method        text CHECK (paid_method IN ('caja', 'efectivo', 'transferencia', 'otro')),
  paid_by            uuid,
  cash_movement_id   uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (period_id, employee_id),
  FOREIGN KEY (restaurant_id, period_id)        REFERENCES payroll_periods (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, employee_id)      REFERENCES employees (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, branch_id)        REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, paid_by)          REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, cash_movement_id) REFERENCES cash_movements (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX payroll_items_employee_idx ON payroll_items (restaurant_id, employee_id);

CREATE TABLE payroll_item_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('percepcion', 'deduccion')),
  code          text NOT NULL,
  concept       text NOT NULL,
  amount        numeric(10,2) NOT NULL CHECK (amount >= 0),
  adjustment_id uuid,
  sort_order    integer NOT NULL DEFAULT 0,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, item_id)       REFERENCES payroll_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, adjustment_id) REFERENCES payroll_adjustments (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX payroll_item_lines_item_idx ON payroll_item_lines (restaurant_id, item_id);
CREATE INDEX payroll_item_lines_adjustment_idx ON payroll_item_lines (restaurant_id, adjustment_id) WHERE adjustment_id IS NOT NULL;

-- Aceptacion del recibo por el empleado (casilla + fecha), como las firmas
-- de prenomina del sistema original.
CREATE TABLE payroll_receipt_signatures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL,
  employee_id   uuid NOT NULL,
  user_id       uuid NOT NULL,
  accepted      boolean NOT NULL DEFAULT true CHECK (accepted),
  net_at_signing numeric(10,2) NOT NULL,
  ip            text,
  user_agent    text,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (item_id),
  FOREIGN KEY (restaurant_id, item_id)     REFERENCES payroll_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, user_id)     REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);

-- ---------------------------------------------------------------------------
-- Empleado del mes
-- ---------------------------------------------------------------------------

CREATE TABLE recognition_settings (
  restaurant_id         uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Pesos relativos de cada componente (0 = no cuenta). Asistencia y
  -- puntualidad requieren el modulo rh; ventas, el modulo pos.
  weight_attendance     integer NOT NULL DEFAULT 30 CHECK (weight_attendance BETWEEN 0 AND 100),
  weight_punctuality    integer NOT NULL DEFAULT 20 CHECK (weight_punctuality BETWEEN 0 AND 100),
  weight_sales          integer NOT NULL DEFAULT 20 CHECK (weight_sales BETWEEN 0 AND 100),
  weight_evaluation     integer NOT NULL DEFAULT 20 CHECK (weight_evaluation BETWEEN 0 AND 100),
  weight_tasks          integer NOT NULL DEFAULT 10 CHECK (weight_tasks BETWEEN 0 AND 100),
  -- Dias trabajados minimos en el mes para poder ganar (si hay datos de rh).
  min_days_worked       integer NOT NULL DEFAULT 0 CHECK (min_days_worked BETWEEN 0 AND 31),
  prize_text            text,
  prize_amount          numeric(10,2) NOT NULL DEFAULT 0 CHECK (prize_amount >= 0),
  -- Agregar el premio como bono en la nomina (requiere el modulo rh).
  prize_to_payroll      boolean NOT NULL DEFAULT false,
  -- Cerrar el mes anterior automaticamente el dia 1.
  auto_close            boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recognition_evaluations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  year          integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month         integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  score         integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  comment       text,
  evaluator_id  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (employee_id, year, month, evaluator_id),
  FOREIGN KEY (restaurant_id, employee_id)  REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, evaluator_id) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX recognition_evaluations_month_idx ON recognition_evaluations (restaurant_id, year, month);

CREATE TABLE recognition_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  title         text NOT NULL,
  description   text,
  points        integer NOT NULL DEFAULT 10 CHECK (points BETWEEN 1 AND 1000),
  due_date      date,
  status        text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'completada', 'cancelada')),
  completed_at  timestamptz,
  verified_by   uuid,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK (status <> 'completada' OR completed_at IS NOT NULL),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, verified_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX recognition_tasks_employee_idx ON recognition_tasks (restaurant_id, employee_id, status);

-- Mes cerrado (uno por restaurante y mes: cerrar dos veces no duplica).
CREATE TABLE recognition_months (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  year          integer NOT NULL,
  month         integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  weights       jsonb NOT NULL,
  prize_text    text,
  prize_amount  numeric(10,2) NOT NULL DEFAULT 0,
  closed_at     timestamptz NOT NULL DEFAULT now(),
  -- NULL = lo cerro el job automatico.
  closed_by     uuid,
  PRIMARY KEY (restaurant_id, year, month),
  FOREIGN KEY (restaurant_id, closed_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE recognition_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  year          integer NOT NULL,
  month         integer NOT NULL,
  branch_id     uuid NOT NULL,
  employee_id   uuid NOT NULL,
  employee_name text NOT NULL,
  rank          integer NOT NULL CHECK (rank >= 1),
  score         numeric(6,2) NOT NULL,
  components    jsonb NOT NULL,
  is_winner     boolean NOT NULL DEFAULT false,
  -- Bono generado en la nomina (si prize_to_payroll).
  adjustment_id uuid,
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, year, month, employee_id),
  FOREIGN KEY (restaurant_id, year, month)   REFERENCES recognition_months (restaurant_id, year, month) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)     REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, employee_id)   REFERENCES employees (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, adjustment_id) REFERENCES payroll_adjustments (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
-- Un solo ganador por sucursal y mes.
CREATE UNIQUE INDEX recognition_results_one_winner ON recognition_results (restaurant_id, year, month, branch_id) WHERE is_winner;

-- ---------------------------------------------------------------------------
-- Valores iniciales por restaurante
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seed_hr_defaults(rid uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO payroll_settings (restaurant_id) VALUES (rid) ON CONFLICT DO NOTHING;
  INSERT INTO recognition_settings (restaurant_id) VALUES (rid) ON CONFLICT DO NOTHING;
$$;

-- ---------------------------------------------------------------------------
-- RLS (misma politica que 003)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_areas', 'employees', 'employee_schedules', 'hr_clock_settings',
    'time_entries', 'time_entry_audit', 'attendance_justifications',
    'payroll_settings', 'hr_holidays', 'payroll_adjustments',
    'payroll_periods', 'payroll_items', 'payroll_item_lines', 'payroll_receipt_signatures',
    'recognition_settings', 'recognition_evaluations', 'recognition_tasks',
    'recognition_months', 'recognition_results'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))',
      t
    );
  END LOOP;
END
$$;

SELECT set_config('app.is_platform', 'on', true);
SELECT seed_hr_defaults(id) FROM restaurants;
