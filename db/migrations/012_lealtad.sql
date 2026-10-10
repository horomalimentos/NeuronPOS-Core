-- 012: Clientes y lealtad (modulo 'lealtad'), adaptado del programa de
-- puntos de Horom.
--
-- * Clientes dados de alta en caja: solo nombre y telefono (sin correo ni
--   contrasena). Si despues se registran en el portal con el mismo correo, se
--   les asigna esa misma ficha.
-- * Puntos: se ganan al pagarse la orden (POS, pedido en linea entregado o
--   domicilio pagado) y se canjean en caja como un pago con el metodo
--   "Puntos" (kind 'puntos'), autorizado con el codigo de 6 digitos que el
--   cliente ve en su cuenta y que cambia cada 5 minutos.
-- * El historial de puntos (loyalty_transactions) siempre cuadra con el
--   saldo de customers.points_balance.

ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE customers ADD CONSTRAINT customers_login_needs_email CHECK (password_hash IS NULL OR email IS NOT NULL);
ALTER TABLE customers ADD CONSTRAINT customers_email_or_phone CHECK (email IS NOT NULL OR phone IS NOT NULL);
ALTER TABLE customers
  ADD COLUMN notes              text,
  ADD COLUMN created_by         uuid,
  -- Ultimos 10 digitos del telefono, para buscar en caja.
  ADD COLUMN phone_digits       text GENERATED ALWAYS AS (right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)) STORED,
  ADD COLUMN points_balance     integer NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  ADD COLUMN points_earned      integer NOT NULL DEFAULT 0,
  ADD COLUMN points_redeemed    integer NOT NULL DEFAULT 0,
  -- Codigo para canjear en caja (TOTP de 6 digitos, ventana de 5 minutos).
  ADD COLUMN pos_code_secret    bytea,
  ADD COLUMN pos_code_last_step bigint,
  ADD COLUMN pos_code_failures  smallint NOT NULL DEFAULT 0,
  ADD COLUMN pos_code_locked    boolean NOT NULL DEFAULT false;
CREATE INDEX customers_phone_idx ON customers (restaurant_id, phone_digits) WHERE phone_digits <> '';

CREATE TABLE loyalty_settings (
  restaurant_id        uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  program_name         text NOT NULL DEFAULT 'Puntos',
  earn_enabled         boolean NOT NULL DEFAULT true,
  redeem_enabled       boolean NOT NULL DEFAULT true,
  -- Puntos por cada peso pagado (1 = un punto por peso).
  points_per_peso      numeric(10,4) NOT NULL DEFAULT 1 CHECK (points_per_peso >= 0),
  -- Valor en pesos de un punto al canjear (0.04 = 25 puntos por $1).
  peso_per_point       numeric(10,4) NOT NULL DEFAULT 0.04 CHECK (peso_per_point > 0),
  min_redeem_points    integer NOT NULL DEFAULT 25 CHECK (min_redeem_points >= 0),
  -- Tope de puntos por orden (NULL = sin tope).
  max_points_per_order integer CHECK (max_points_per_order IS NULL OR max_points_per_order > 0),
  -- Pedir el codigo del cliente para canjear (si no, basta con la caja).
  require_code         boolean NOT NULL DEFAULT true,
  earn_on_web          boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL,
  -- earn: compra; redeem: canje en caja; reverse: canje devuelto; adjust: manual.
  kind          text NOT NULL CHECK (kind IN ('earn', 'redeem', 'reverse', 'adjust')),
  points        integer NOT NULL CHECK (points <> 0),
  balance_after integer NOT NULL,
  amount        numeric(10,2),
  order_id      uuid,
  payment_id    uuid,
  reason        text,
  created_by    uuid,
  -- clock_timestamp: varios movimientos de una misma transaccion quedan en orden.
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, order_id)    REFERENCES orders (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX loyalty_transactions_customer_idx ON loyalty_transactions (restaurant_id, customer_id, created_at DESC);
-- Una orden gana puntos una sola vez.
CREATE UNIQUE INDEX loyalty_transactions_one_earn ON loyalty_transactions (order_id) WHERE kind = 'earn';

-- Metodo de pago "Puntos": lo registra el canje, nunca se elige a mano.
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
  CHECK (kind IN ('efectivo', 'tarjeta', 'transferencia', 'otro', 'en_linea', 'puntos'));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_settings', 'loyalty_transactions'] LOOP
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
  ('lealtad', 'Clientes y lealtad',
   'Fichas de clientes con historial, programa de puntos que se ganan al comprar y se canjean en caja con código seguro.', 200, 18)
ON CONFLICT (code) DO NOTHING;
