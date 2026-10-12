-- 031: Ventas por evento y preventas (como "Ventas por evento" de Horom),
-- modulo "eventos".
--
-- Un evento (venta en un centro de trabajo, preventa de fin de semana, carne
-- asada...) tiene fecha, fecha limite para pedir y sus propios productos con
-- precio y cupo. Los pedidos los levanta el personal (vendedor) o el cliente
-- en la pagina publica /evento/<slug>. Se cobran en efectivo al entregar (o
-- antes), la cocina ve cuanto preparar de cada producto y el gerente controla
-- el efectivo que junto cada vendedor y su comision.

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('eventos', 'Eventos y preventas', 'Ventas por evento con pagina para pedir, cupo por producto, produccion y control de vendedores.', 0, 23)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
  place          text CHECK (place IS NULL OR length(place) <= 200),
  description    text CHECK (description IS NULL OR length(description) <= 2000),
  sale_date      date NOT NULL,
  order_deadline timestamptz,
  status         text NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'abierto', 'cerrado', 'terminado')),
  -- Comision del vendedor: % de lo que vende.
  commission_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, slug),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);

CREATE TABLE event_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  event_id      uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description   text CHECK (description IS NULL OR length(description) <= 500),
  price         numeric(10,2) NOT NULL CHECK (price >= 0),
  image_url     text,
  -- Cupo total (NULL = sin limite).
  max_quantity  integer CHECK (max_quantity IS NULL OR max_quantity > 0),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, event_id) REFERENCES events (restaurant_id, id) ON DELETE CASCADE
);

CREATE TABLE event_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL,
  event_id       uuid NOT NULL,
  folio          integer NOT NULL,
  customer_name  text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  customer_phone text,
  notes          text CHECK (notes IS NULL OR length(notes) <= 500),
  -- Quien lo levanto (NULL = el cliente en la pagina publica).
  seller_id      uuid,
  status         text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'pagado', 'cancelado')),
  total          numeric(10,2) NOT NULL DEFAULT 0,
  paid_at        timestamptz,
  paid_by        uuid,
  delivered_at   timestamptz,
  delivered_by   uuid,
  public_token   text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (event_id, folio),
  FOREIGN KEY (restaurant_id, event_id)     REFERENCES events (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, seller_id)    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, paid_by)      REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, delivered_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX event_orders_event_idx ON event_orders (restaurant_id, event_id, status);

CREATE TABLE event_order_items (
  restaurant_id uuid NOT NULL,
  order_id      uuid NOT NULL,
  product_id    uuid NOT NULL,
  name          text NOT NULL,
  price         numeric(10,2) NOT NULL,
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (restaurant_id, order_id)   REFERENCES event_orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES event_products (restaurant_id, id) ON DELETE CASCADE
);

-- Efectivo que cada vendedor entrego y comision pagada (una fila por vendedor y evento).
CREATE TABLE event_seller_settlements (
  restaurant_id   uuid NOT NULL,
  event_id        uuid NOT NULL,
  seller_id       uuid NOT NULL,
  cash_delivered  numeric(10,2) NOT NULL DEFAULT 0 CHECK (cash_delivered >= 0),
  commission_paid boolean NOT NULL DEFAULT false,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, seller_id),
  FOREIGN KEY (restaurant_id, event_id)  REFERENCES events (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, seller_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['events', 'event_products', 'event_orders', 'event_order_items', 'event_seller_settlements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))', t);
  END LOOP;
END $$;
