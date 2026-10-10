-- 019: Turnos y rol semanal (modulo 'turnos'), adaptado de Horom
-- (shifts.js, employeeShifts.js, WeeklySchedule.tsx).
--
-- * Catalogo de turnos reutilizables por restaurante (Matutino 07:00-15:00...).
-- * Rol por fecha: a cada empleado se le asigna un turno, un horario a mano o
--   descanso en un dia concreto. Lo asignado manda sobre su horario fijo
--   semanal (employee_schedules) en asistencia, retardos y nomina; un dia sin
--   asignar sigue usando el horario fijo.

CREATE TABLE shift_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  color         text NOT NULL DEFAULT '#3B82F6' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE INDEX shift_templates_restaurant_idx ON shift_templates (restaurant_id);

CREATE TABLE employee_shift_days (
  restaurant_id uuid NOT NULL,
  employee_id   uuid NOT NULL,
  date          date NOT NULL,
  -- Turno del catalogo (para nombre y color); las horas se copian al
  -- asignarlo, asi editar el catalogo no reescribe semanas pasadas.
  shift_id      uuid,
  is_rest       boolean NOT NULL DEFAULT false,
  start_time    time,
  end_time      time,
  note          text CHECK (length(note) <= 200),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, date),
  CHECK (is_rest = (start_time IS NULL) AND (start_time IS NULL) = (end_time IS NULL)),
  CHECK (NOT is_rest OR shift_id IS NULL),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, shift_id)    REFERENCES shift_templates (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, updated_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX employee_shift_days_date_idx ON employee_shift_days (restaurant_id, date);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_templates', 'employee_shift_days'] LOOP
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

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('turnos', 'Turnos y rol semanal',
   'Catálogo de turnos y rol semanal por empleado (turnos que rotan, descansos movibles, copiar la semana). La asistencia, los retardos y la nómina usan el turno de cada día. Requiere Recursos humanos.', 80, 42)
ON CONFLICT (code) DO NOTHING;
