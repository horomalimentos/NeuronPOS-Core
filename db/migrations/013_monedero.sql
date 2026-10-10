-- 013: Monedero del cliente (modulo 'monedero'), adaptado del monedero de
-- Horom.
--
-- * El cliente recarga saldo desde "Mi cuenta" del sitio con tarjeta (liga
--   de Clip del restaurante, purpose 'recarga'); se acredita cuando Clip
--   confirma el pago (webhook o conciliador), una sola vez.
-- * Paga con su saldo pedidos en linea (sin codigo: ya inicio sesion) y en
--   caja como pago "Monedero" (kind 'monedero'), autorizado con el mismo
--   codigo de 6 digitos de la lealtad.
-- * Si el restaurante rechaza un pedido en linea pagado con monedero, el
--   dinero regresa solo al monedero.
-- * El historial (wallet_transactions) siempre cuadra con
--   customers.wallet_balance.

ALTER TABLE customers
  ADD COLUMN wallet_balance numeric(10,2) NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
  ADD COLUMN wallet_loaded  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN wallet_spent   numeric(12,2) NOT NULL DEFAULT 0;

CREATE TABLE wallet_settings (
  restaurant_id     uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Recargas en linea (necesitan Clip configurado y "pago en linea").
  topups_enabled    boolean NOT NULL DEFAULT true,
  min_topup         numeric(10,2) NOT NULL DEFAULT 50 CHECK (min_topup >= 10),
  max_topup         numeric(10,2) NOT NULL DEFAULT 5000,
  suggested_amounts integer[] NOT NULL DEFAULT '{100,200,500}',
  -- Tope de saldo por cliente.
  max_balance       numeric(10,2) NOT NULL DEFAULT 20000,
  -- Pagar pedidos en linea con el saldo.
  web_enabled       boolean NOT NULL DEFAULT true,
  -- Pedir el codigo del cliente para cobrar en caja.
  require_code      boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (max_topup > min_topup),
  CHECK (max_balance >= max_topup)
);

-- Recargas: la liga de Clip es el registro de la recarga.
ALTER TABLE clip_checkouts DROP CONSTRAINT IF EXISTS clip_checkouts_purpose_check;
ALTER TABLE clip_checkouts ADD CONSTRAINT clip_checkouts_purpose_check
  CHECK (purpose IN ('suscripcion', 'pedido', 'recarga'));
ALTER TABLE clip_checkouts
  ADD COLUMN customer_id uuid,
  ADD CONSTRAINT clip_checkouts_recarga_customer CHECK ((purpose = 'recarga') = (customer_id IS NOT NULL)),
  ADD CONSTRAINT clip_checkouts_customer_fk FOREIGN KEY (restaurant_id, customer_id)
    REFERENCES customers (restaurant_id, id) ON DELETE CASCADE;
CREATE INDEX clip_checkouts_customer_idx ON clip_checkouts (restaurant_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE wallet_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL,
  -- topup: recarga con tarjeta; purchase: pago; refund: devolucion; adjust: manual.
  kind          text NOT NULL CHECK (kind IN ('topup', 'purchase', 'refund', 'adjust')),
  amount        numeric(10,2) NOT NULL CHECK (amount <> 0),
  balance_after numeric(10,2) NOT NULL,
  order_id      uuid,
  payment_id    uuid,
  checkout_id   uuid,
  reason        text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, order_id)    REFERENCES orders (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, checkout_id) REFERENCES clip_checkouts (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX wallet_transactions_customer_idx ON wallet_transactions (restaurant_id, customer_id, created_at DESC);
-- Una recarga se acredita una vez; un pago se devuelve una vez.
CREATE UNIQUE INDEX wallet_transactions_one_topup ON wallet_transactions (checkout_id) WHERE kind = 'topup';
CREATE UNIQUE INDEX wallet_transactions_one_refund ON wallet_transactions (payment_id) WHERE kind = 'refund';

-- Pagos con monedero en pedidos en linea: sin turno ni usuario, ligados al cliente.
ALTER TABLE order_payments ADD COLUMN wallet_customer_id uuid;
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_origin;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_origin CHECK (
  clip_checkout_id IS NOT NULL
  OR delivery_request_id IS NOT NULL
  OR wallet_customer_id IS NOT NULL
  OR (created_by IS NOT NULL AND (cash_session_id IS NOT NULL OR driver_user_id IS NOT NULL))
);

ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
  CHECK (kind IN ('efectivo', 'tarjeta', 'transferencia', 'otro', 'en_linea', 'puntos', 'monedero'));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallet_settings', 'wallet_transactions'] LOOP
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
  ('monedero', 'Monedero del cliente',
   'Saldo prepagado que el cliente recarga con tarjeta en el sitio y usa para pagar en línea o en caja con código seguro.', 150, 19)
ON CONFLICT (code) DO NOTHING;
