-- 018: Vales y codigos promocionales (como los "Vales" y codigos promo de
-- Horom), dentro del modulo "promociones".
--
-- Un vale tiene un codigo y da $ o % de descuento, o un producto gratis (si
-- viene en la orden). Puede tener minimo de compra, vigencia, usos maximos y
-- si aplica en caja y/o en linea. Se aplica a una orden con su codigo; el uso
-- se cuenta cuando la orden queda pagada (voucher_redemptions).

CREATE TABLE vouchers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code           text NOT NULL CHECK (code ~ '^[A-Z0-9-]{3,30}$'),
  description    text CHECK (description IS NULL OR length(description) <= 200),
  kind           text NOT NULL CHECK (kind IN ('monto', 'porcentaje', 'producto')),
  amount         numeric(10,2) CHECK (amount IS NULL OR amount > 0),
  percent        numeric(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  menu_item_id   uuid,
  min_amount     numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  -- NULL = sin limite.
  max_uses       integer CHECK (max_uses IS NULL OR max_uses >= 1),
  starts_on      date,
  ends_on        date,
  applies_pos    boolean NOT NULL DEFAULT true,
  applies_web    boolean NOT NULL DEFAULT true,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, code),
  FOREIGN KEY (restaurant_id, menu_item_id) REFERENCES menu_items (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (kind <> 'monto' OR amount IS NOT NULL),
  CHECK (kind <> 'porcentaje' OR percent IS NOT NULL),
  CHECK (kind <> 'producto' OR menu_item_id IS NOT NULL)
);

CREATE TABLE voucher_redemptions (
  restaurant_id uuid NOT NULL,
  voucher_id    uuid NOT NULL,
  order_id      uuid NOT NULL,
  amount        numeric(10,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (voucher_id, order_id),
  FOREIGN KEY (restaurant_id, voucher_id) REFERENCES vouchers (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, order_id)   REFERENCES orders (restaurant_id, id)   ON DELETE CASCADE
);
CREATE INDEX voucher_redemptions_restaurant_idx ON voucher_redemptions (restaurant_id, voucher_id);

ALTER TABLE orders
  ADD COLUMN voucher_id       uuid,
  ADD COLUMN voucher_discount numeric(10,2) NOT NULL DEFAULT 0 CHECK (voucher_discount >= 0),
  ADD CONSTRAINT orders_voucher_fk FOREIGN KEY (restaurant_id, voucher_id) REFERENCES vouchers (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vouchers USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
ALTER TABLE voucher_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voucher_redemptions USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
