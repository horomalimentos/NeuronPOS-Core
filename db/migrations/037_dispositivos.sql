-- 025: Control de dispositivos (como el registro de terminales de Horom),
-- modulo "dispositivos".
--
-- Con el modulo activo, solo los equipos autorizados por el gerente pueden
-- abrir y cerrar caja, cobrar, registrar entradas/salidas y recargar monederos.
-- Cada navegador o app genera una llave aleatoria (se guarda solo su hash),
-- pide su alta con nombre, sucursal y caja, y el gerente la aprueba o revoca.

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('dispositivos', 'Control de dispositivos', 'Solo los equipos autorizados por el gerente pueden abrir caja y cobrar.', 0, 22)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE pos_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  -- Caja que usa (el turno se abre con este nombre).
  terminal      text NOT NULL CHECK (length(terminal) BETWEEN 1 AND 40),
  token_hash    text NOT NULL,
  status        text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'activo', 'revocado')),
  user_agent    text,
  requested_by  uuid,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, token_hash),
  FOREIGN KEY (restaurant_id, branch_id)    REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, requested_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, reviewed_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE pos_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pos_devices USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
