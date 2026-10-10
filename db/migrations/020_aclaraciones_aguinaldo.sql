-- 020: Prenomina en vivo, aclaraciones del empleado y aguinaldo (parte del
-- modulo 'rh'), adaptado de Horom (prenominaLive.js, prenomina.js claims,
-- aguinaldoGoals.js).
--
-- * Aclaracion: el empleado reporta algo de su asistencia o de un recibo
--   (una falta que no fue, horas que no le contaron...). Mientras este
--   pendiente no puede firmar ese recibo. El gerente la resuelve (corrige lo
--   que haga falta) o la rechaza, con respuesta.
-- * Aguinaldo (LFT art. 87): minimo 15 dias de salario por año, proporcional
--   a los dias trabajados en el año. Se registra el pago por empleado.

ALTER TABLE payroll_settings
  ADD COLUMN aguinaldo_days integer NOT NULL DEFAULT 15 CHECK (aguinaldo_days BETWEEN 15 AND 90);

CREATE TABLE payroll_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  -- Sobre un recibo (item) o sobre un dia de la prenomina en vivo.
  item_id       uuid,
  date          date,
  kind          text NOT NULL CHECK (kind IN ('falta', 'retardo', 'horas', 'pago', 'descuento', 'otro')),
  description   text NOT NULL CHECK (length(description) BETWEEN 10 AND 1000),
  amount        numeric(10,2) CHECK (amount IS NULL OR amount > 0),
  status        text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'resuelta', 'rechazada')),
  response      text CHECK (length(response) <= 1000),
  resolved_by   uuid,
  resolved_at   timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (item_id IS NOT NULL OR date IS NOT NULL),
  CHECK (status = 'pendiente' OR (resolved_at IS NOT NULL AND response IS NOT NULL)),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, item_id)     REFERENCES payroll_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, resolved_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX payroll_claims_status_idx ON payroll_claims (restaurant_id, status, created_at DESC);
CREATE INDEX payroll_claims_employee_idx ON payroll_claims (restaurant_id, employee_id);

CREATE TABLE aguinaldo_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  year           integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  employee_id    uuid NOT NULL,
  -- Lo usado en el calculo (queda fijo aunque cambie el salario despues).
  days_counted   integer NOT NULL CHECK (days_counted BETWEEN 0 AND 366),
  daily_base     numeric(10,2) NOT NULL CHECK (daily_base >= 0),
  aguinaldo_days integer NOT NULL,
  calculated     numeric(10,2) NOT NULL CHECK (calculated >= 0),
  amount         numeric(10,2) NOT NULL CHECK (amount > 0),
  method         text NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'otro')),
  notes          text CHECK (length(notes) <= 300),
  paid_at        timestamptz NOT NULL DEFAULT now(),
  paid_by        uuid,
  UNIQUE (restaurant_id, year, employee_id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, paid_by)     REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_claims', 'aguinaldo_payments'] LOOP
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
