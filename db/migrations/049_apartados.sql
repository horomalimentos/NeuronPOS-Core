-- 049: Apartados de dinero y metas de aguinaldo (como "Fianzas Sanas" de
-- Horom), modulo "apartados".
--
-- Un apartado es dinero que se va guardando para algo (aguinaldo, renta,
-- predial, un equipo nuevo) con una meta y, si se quiere, una fecha limite y
-- un plan de cuotas (diarias, semanales, quincenales o mensuales) que se van
-- marcando como apartadas. El saldo sale de los movimientos (depositos menos
-- retiros); marcar una cuota crea su deposito.
--
-- Alcance: 'negocio' (de una sucursal o de todo el restaurante; lo manejan
-- admin y gerente) o 'personal' (solo su dueno). Cualquiera de los dos se
-- puede compartir con otros usuarios, solo para ver o tambien para registrar.
--
-- Los de tipo 'aguinaldo' calculan la meta con el aguinaldo de los empleados
-- del año (modulo rh) y vencen el 20 de diciembre.

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('apartados', 'Apartados y aguinaldo', 'Aparta dinero por cuotas para el aguinaldo, la renta u otras metas, con avance y movimientos.', 0, 56)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE savings_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'libre' CHECK (kind IN ('libre', 'aguinaldo')),
  scope         text NOT NULL DEFAULT 'negocio' CHECK (scope IN ('negocio', 'personal')),
  branch_id     uuid,
  owner_id      uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description   text CHECK (description IS NULL OR length(description) <= 500),
  color         text NOT NULL DEFAULT '#3B82F6' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  target_amount numeric(12,2) NOT NULL CHECK (target_amount > 0),
  -- Plan de cuotas: NULL = sin cuotas (se deposita cuando se puede).
  frequency     text CHECK (frequency IN ('diaria', 'semanal', 'quincenal', 'mensual')),
  -- Dias que cuentan en el plan diario (1 = lunes ... 7 = domingo).
  weekdays      smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  start_date    date NOT NULL,
  due_date      date,
  aguinaldo_year integer CHECK (aguinaldo_year IS NULL OR aguinaldo_year BETWEEN 2000 AND 2100),
  status        text NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'completado', 'cancelado')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK (scope = 'negocio' OR branch_id IS NULL),
  CHECK (kind <> 'aguinaldo' OR aguinaldo_year IS NOT NULL),
  CHECK (frequency IS NULL OR due_date IS NOT NULL),
  CHECK (due_date IS NULL OR due_date >= start_date),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, owner_id)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX savings_goals_restaurant_idx ON savings_goals (restaurant_id, status);

CREATE TABLE savings_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  goal_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('deposito', 'retiro')),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  occurred_on   date NOT NULL,
  notes         text CHECK (notes IS NULL OR length(notes) <= 300),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, goal_id)    REFERENCES savings_goals (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, created_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX savings_movements_goal_idx ON savings_movements (goal_id, occurred_on DESC);

CREATE TABLE savings_installments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  goal_id       uuid NOT NULL,
  due_on        date NOT NULL,
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  -- Deposito que se creo al marcarla (NULL = pendiente).
  movement_id   uuid UNIQUE REFERENCES savings_movements(id) ON DELETE SET NULL,
  done_at       timestamptz,
  done_by       uuid,
  FOREIGN KEY (restaurant_id, goal_id)     REFERENCES savings_goals (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, done_by)     REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX savings_installments_goal_idx ON savings_installments (goal_id, due_on);

CREATE TABLE savings_shares (
  restaurant_id uuid NOT NULL,
  goal_id       uuid NOT NULL,
  user_id       uuid NOT NULL,
  -- false = solo consulta; true = tambien registra movimientos y cuotas.
  can_edit      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, user_id),
  FOREIGN KEY (restaurant_id, goal_id) REFERENCES savings_goals (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, user_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['savings_goals', 'savings_movements', 'savings_installments', 'savings_shares'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))', t);
  END LOOP;
END $$;
