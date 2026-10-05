-- 005: Sitio web, horarios de sucursal y portal de clientes con pedidos en
-- linea (Fase 2).
--
-- - site_content / site_gallery: contenido editable del sitio publico de
--   cada restaurante (modulo "landing"). Las imagenes son URLs por ahora.
-- - branch_hours / branch_closures: horario semanal por sucursal y dias
--   cerrados. Se usan para mostrar abierto/cerrado y para aceptar pedidos en
--   linea solo con la sucursal abierta.
-- - online_settings / branch_online_settings: configuracion de pedidos en
--   linea (modulo "portal") y costo de envio por sucursal.
-- - customers / customer_addresses: cuentas de clientes POR RESTAURANTE (el
--   mismo correo puede tener cuenta en dos restaurantes y son cuentas
--   distintas).
-- - orders: los pedidos en linea son ordenes normales del POS con
--   source = 'web'; llevan su propio estado de aceptacion (online_status),
--   costo de envio y token de seguimiento para el cliente.
--
-- Mismas reglas que 004: restaurant_id + UNIQUE (restaurant_id, id), llaves
-- foraneas compuestas y RLS (FORCE) en todas las tablas nuevas.

-- ---------------------------------------------------------------------------
-- Sitio web
-- ---------------------------------------------------------------------------

-- Un documento JSON por restaurante (hero, acerca de, redes, SEO...). El
-- backend valida y normaliza las llaves (routes/website.js).
CREATE TABLE site_content (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content) = 'object'),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_gallery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  image_url     text NOT NULL,
  caption       text,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE INDEX site_gallery_restaurant_idx ON site_gallery (restaurant_id, sort_order);

-- ---------------------------------------------------------------------------
-- Horarios por sucursal
-- ---------------------------------------------------------------------------

-- Un horario por dia de la semana (0 = domingo ... 6 = sabado), en la zona
-- horaria de la sucursal. Sin fila = cerrado ese dia.
--   opens_at < closes_at  : horario normal.
--   opens_at > closes_at  : cierra despues de medianoche (ej. 18:00 a 02:00).
--   opens_at = closes_at  : abierto las 24 horas.
CREATE TABLE branch_hours (
  restaurant_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at      time NOT NULL,
  closes_at     time NOT NULL,
  PRIMARY KEY (branch_id, weekday),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX branch_hours_restaurant_idx ON branch_hours (restaurant_id);

-- Dias cerrados (festivos, inventario...): ese dia la sucursal no abre.
CREATE TABLE branch_closures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  closed_on     date NOT NULL,
  reason        text,
  UNIQUE (restaurant_id, id),
  UNIQUE (branch_id, closed_on),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX branch_closures_restaurant_idx ON branch_closures (restaurant_id, branch_id, closed_on);

-- ---------------------------------------------------------------------------
-- Pedidos en linea: configuracion
-- ---------------------------------------------------------------------------

CREATE TABLE online_settings (
  restaurant_id     uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Interruptor general: el restaurante decide cuando empieza a recibir pedidos.
  enabled           boolean NOT NULL DEFAULT false,
  -- Pedido minimo sobre el subtotal de productos (sin envio). 0 = sin minimo.
  min_order         numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  -- Tiempo estimado de preparacion que se le muestra al cliente.
  prep_time_minutes integer NOT NULL DEFAULT 30 CHECK (prep_time_minutes BETWEEN 1 AND 600),
  -- true = el pedido entra directo a cocina; false = el POS lo acepta o rechaza.
  auto_accept       boolean NOT NULL DEFAULT false,
  allow_pickup      boolean NOT NULL DEFAULT true,
  -- Ademas requiere el modulo "domicilios".
  allow_delivery    boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Por sucursal: si recibe pedidos en linea, si entrega a domicilio y el
-- costo de envio (monto fijo por ahora). Sin fila = valores por defecto.
CREATE TABLE branch_online_settings (
  restaurant_id    uuid NOT NULL,
  branch_id        uuid PRIMARY KEY,
  online_enabled   boolean NOT NULL DEFAULT true,
  delivery_enabled boolean NOT NULL DEFAULT true,
  delivery_fee     numeric(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX branch_online_settings_restaurant_idx ON branch_online_settings (restaurant_id);

-- ---------------------------------------------------------------------------
-- Clientes (por restaurante)
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  email         citext NOT NULL,
  phone         text,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- El correo es unico dentro del restaurante, no en toda la plataforma.
  UNIQUE (restaurant_id, email),
  UNIQUE (restaurant_id, id)
);

CREATE TABLE customer_addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  customer_id   uuid NOT NULL,
  label         text NOT NULL DEFAULT 'Casa',
  address       text NOT NULL,
  reference     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (restaurant_id, customer_id);

-- ---------------------------------------------------------------------------
-- Ordenes: canal web
-- ---------------------------------------------------------------------------

-- 'pos' = capturada por el personal; 'web' = pedido en linea del cliente.
ALTER TABLE orders ADD COLUMN source text NOT NULL DEFAULT 'pos' CHECK (source IN ('pos', 'web'));
-- Un pedido en linea no lo crea un usuario del restaurante.
ALTER TABLE orders ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_created_by_required CHECK (source = 'web' OR created_by IS NOT NULL);
ALTER TABLE order_items ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE orders
  -- Cliente con cuenta (NULL = pedido como invitado).
  ADD COLUMN customer_id        uuid,
  -- pendiente (espera aceptacion) -> aceptada, o rechazada (con motivo).
  ADD COLUMN online_status      text CHECK (online_status IN ('pendiente', 'aceptada', 'rechazada')),
  ADD COLUMN delivery_fee       numeric(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  ADD COLUMN delivery_reference text,
  -- Pago al recibir: como piensa pagar el cliente y con cuanto (para el cambio).
  ADD COLUMN payment_provider   text,
  ADD COLUMN payment_preference text CHECK (payment_preference IN ('efectivo', 'tarjeta')),
  ADD COLUMN pay_with           numeric(10,2) CHECK (pay_with IS NULL OR pay_with >= 0),
  -- Token aleatorio para que el cliente (o invitado) siga su pedido.
  ADD COLUMN public_token       text UNIQUE,
  ADD COLUMN accepted_at        timestamptz,
  ADD COLUMN accepted_by        uuid,
  ADD COLUMN estimated_ready_at timestamptz,
  ADD COLUMN dispatched_at      timestamptz,
  ADD CONSTRAINT orders_customer_fk FOREIGN KEY (restaurant_id, customer_id)
    REFERENCES customers (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT orders_accepted_by_fk FOREIGN KEY (restaurant_id, accepted_by)
    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT orders_web_fields CHECK (
    (source = 'web') = (online_status IS NOT NULL AND public_token IS NOT NULL)
  ),
  ADD CONSTRAINT orders_web_type CHECK (source <> 'web' OR order_type IN ('para_llevar', 'domicilio'));

CREATE INDEX orders_web_idx ON orders (restaurant_id, branch_id, online_status, created_at DESC) WHERE source = 'web';
CREATE INDEX orders_customer_idx ON orders (restaurant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS (misma politica que 003)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'site_content', 'site_gallery', 'branch_hours', 'branch_closures',
    'online_settings', 'branch_online_settings', 'customers', 'customer_addresses'
  ] LOOP
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
