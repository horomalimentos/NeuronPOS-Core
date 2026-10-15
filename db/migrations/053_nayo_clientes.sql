-- Nayo: cuentas de clientes. Para hacer un pedido hay que registrarse o entrar
-- (correo y contrasena). La cuenta es de la plataforma, no de un restaurante:
-- sirve en todos los restaurantes de Nayo. Solo el backend (plataforma) la lee.
CREATE TABLE nayo_customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  phone               text NOT NULL,
  email               citext NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  active              boolean NOT NULL DEFAULT true,
  password_changed_at timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nayo_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nayo_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON nayo_customers USING (app_is_platform()) WITH CHECK (app_is_platform());

-- De quien es cada pedido (los anteriores a las cuentas quedan sin cliente).
ALTER TABLE marketplace_orders
  ADD COLUMN customer_id uuid REFERENCES nayo_customers(id) ON DELETE SET NULL;
CREATE INDEX marketplace_orders_customer_idx ON marketplace_orders (customer_id, created_at DESC);
