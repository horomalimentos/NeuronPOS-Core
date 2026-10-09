-- 011: Promociones automaticas (como el motor de Horom).
--
-- Tipos:
--   nxm      2x1, 3x2...: de cada buy_quantity piezas se pagan pay_quantity
--            (se regalan las mas baratas).
--   paquete  buy_quantity piezas por bundle_price (ej. 3 tacos por $100).
--   porcentaje  % de descuento en los productos (o en toda la cuenta si no
--            se eligen productos ni categorias).
--   monto    $ de descuento a la cuenta.
--   regalo   al comprar lo elegido (minimo buy_quantity piezas) se regala
--            reward_quantity de reward_item_id (si viene en la orden).
-- Aplica en caja y/o en linea, en sucursales, fechas, dias y horario dados
-- (hora local de la sucursal). Se calculan solas al cambiar la orden; la
-- orden guarda cuales aplicaron y cuanto (order_promotions).

CREATE TABLE promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description     text CHECK (description IS NULL OR length(description) <= 300),
  kind            text NOT NULL CHECK (kind IN ('nxm', 'paquete', 'porcentaje', 'monto', 'regalo')),
  -- Productos o categorias que cuentan (vacios = todo el menu).
  item_ids        uuid[] NOT NULL DEFAULT '{}',
  category_ids    uuid[] NOT NULL DEFAULT '{}',
  buy_quantity    integer CHECK (buy_quantity IS NULL OR buy_quantity BETWEEN 1 AND 100),
  pay_quantity    integer CHECK (pay_quantity IS NULL OR pay_quantity BETWEEN 0 AND 99),
  percent         numeric(5,2) CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  amount          numeric(10,2) CHECK (amount IS NULL OR amount >= 0),
  bundle_price    numeric(10,2) CHECK (bundle_price IS NULL OR bundle_price >= 0),
  reward_item_id  uuid,
  reward_quantity integer CHECK (reward_quantity IS NULL OR reward_quantity BETWEEN 1 AND 100),
  -- Paquete / NxM solo con piezas identicas (mismo producto y opciones).
  same_modifiers  boolean NOT NULL DEFAULT false,
  min_amount      numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  applies_pos     boolean NOT NULL DEFAULT true,
  applies_web     boolean NOT NULL DEFAULT true,
  branch_ids      uuid[] NOT NULL DEFAULT '{}',
  starts_on       date,
  ends_on         date,
  -- 0 = domingo ... 6 = sabado (vacio = todos).
  days_of_week    integer[] NOT NULL DEFAULT '{}',
  start_time      time,
  end_time        time,
  -- Menor numero se aplica primero.
  priority        integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, reward_item_id) REFERENCES menu_items (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (kind <> 'nxm' OR (buy_quantity IS NOT NULL AND pay_quantity IS NOT NULL AND pay_quantity < buy_quantity)),
  CHECK (kind <> 'paquete' OR (buy_quantity IS NOT NULL AND bundle_price IS NOT NULL)),
  CHECK (kind <> 'porcentaje' OR percent IS NOT NULL),
  CHECK (kind <> 'monto' OR amount IS NOT NULL),
  CHECK (kind <> 'regalo' OR reward_item_id IS NOT NULL),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CHECK (days_of_week <@ ARRAY[0, 1, 2, 3, 4, 5, 6])
);
CREATE INDEX promotions_restaurant_idx ON promotions (restaurant_id) WHERE active;

ALTER TABLE orders ADD COLUMN promo_discount numeric(10,2) NOT NULL DEFAULT 0 CHECK (promo_discount >= 0);

CREATE TABLE order_promotions (
  restaurant_id uuid NOT NULL,
  order_id      uuid NOT NULL,
  promotion_id  uuid NOT NULL,
  name          text NOT NULL,
  amount        numeric(10,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (order_id, promotion_id),
  FOREIGN KEY (restaurant_id, order_id)     REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, promotion_id) REFERENCES promotions (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX order_promotions_restaurant_idx ON order_promotions (restaurant_id, promotion_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promotions', 'order_promotions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))',
      t
    );
  END LOOP;
END
$$;
