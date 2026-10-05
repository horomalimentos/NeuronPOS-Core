-- 004: Punto de venta (Fase 1b).
--
-- Menu (categorias, productos, grupos de modificadores), zonas y mesas por
-- sucursal, ordenes con sus articulos, metodos de pago, pagos y caja
-- (sesiones, movimientos y corte por metodo).
--
-- Igual que en 001: toda tabla lleva restaurant_id, UNIQUE (restaurant_id, id)
-- y las relaciones usan llaves foraneas compuestas (restaurant_id, x_id) para
-- que una fila nunca apunte a otra de otro restaurante. Al final se activa
-- RLS (FORCE) en todas las tablas nuevas con la misma politica de 003.
--
-- Las llaves foraneas que no son en cascada (a usuarios, sucursales, mesas,
-- productos, metodos de pago) son DEFERRABLE INITIALLY DEFERRED: se revisan
-- al COMMIT. Asi, al borrar un restaurante completo, la cascada desde
-- restaurants no falla por el orden en que Postgres borra las tablas; y
-- borrar algo que sigue referenciado sigue fallando (al confirmar).
--
-- Montos en numeric(10,2) (pesos). Los calculos se hacen en centavos en
-- backend/services/posMath.js.

-- ---------------------------------------------------------------------------
-- Configuracion del POS por restaurante
-- ---------------------------------------------------------------------------

CREATE TABLE pos_settings (
  restaurant_id            uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- IVA en porcentaje (16 = 16 %).
  tax_rate_pct             numeric(5,2) NOT NULL DEFAULT 16 CHECK (tax_rate_pct BETWEEN 0 AND 100),
  -- true = los precios del menu ya incluyen el impuesto (lo comun en Mexico):
  -- el impuesto se desglosa del total. false = se suma encima del subtotal.
  prices_include_tax       boolean NOT NULL DEFAULT true,
  -- Descuento maximo (en % de la cuenta) que puede dar un cajero. 0 = el
  -- cajero no puede dar descuentos. Admin y gerente no tienen limite.
  cashier_max_discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (cashier_max_discount_pct BETWEEN 0 AND 100),
  -- Textos opcionales del ticket impreso.
  ticket_header            text,
  ticket_footer            text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------

CREATE TABLE menu_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE INDEX menu_categories_restaurant_idx ON menu_categories (restaurant_id, sort_order);

CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL,
  name          text NOT NULL,
  description   text,
  price         numeric(10,2) NOT NULL CHECK (price >= 0),
  image_url     text,
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, category_id) REFERENCES menu_categories (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX menu_items_restaurant_idx ON menu_items (restaurant_id, category_id);

-- Disponibilidad por sucursal. Sin fila = disponible; una fila con
-- available = false lo marca como agotado / no se vende en esa sucursal.
CREATE TABLE menu_item_branches (
  restaurant_id uuid NOT NULL,
  menu_item_id  uuid NOT NULL,
  branch_id     uuid NOT NULL,
  available     boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (menu_item_id, branch_id),
  FOREIGN KEY (restaurant_id, menu_item_id) REFERENCES menu_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)    REFERENCES branches (restaurant_id, id)   ON DELETE CASCADE
);
CREATE INDEX menu_item_branches_restaurant_idx ON menu_item_branches (restaurant_id);

CREATE TABLE modifier_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  -- min 0 = opcional; min >= 1 = obligatorio. max NULL = sin limite.
  min_selections integer NOT NULL DEFAULT 0 CHECK (min_selections >= 0),
  max_selections integer CHECK (max_selections IS NULL OR max_selections >= 1),
  sort_order     integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK (max_selections IS NULL OR max_selections >= min_selections)
);
CREATE INDEX modifier_groups_restaurant_idx ON modifier_groups (restaurant_id);

CREATE TABLE modifiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL,
  name          text NOT NULL,
  -- Ajuste al precio del producto (puede ser negativo, ej. "sin queso -5").
  price_delta   numeric(10,2) NOT NULL DEFAULT 0 CHECK (price_delta BETWEEN -99999 AND 99999),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, group_id) REFERENCES modifier_groups (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX modifiers_restaurant_idx ON modifiers (restaurant_id, group_id);

CREATE TABLE menu_item_modifier_groups (
  restaurant_id     uuid NOT NULL,
  menu_item_id      uuid NOT NULL,
  modifier_group_id uuid NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (menu_item_id, modifier_group_id),
  FOREIGN KEY (restaurant_id, menu_item_id)      REFERENCES menu_items (restaurant_id, id)      ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, modifier_group_id) REFERENCES modifier_groups (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX menu_item_modifier_groups_restaurant_idx ON menu_item_modifier_groups (restaurant_id);

-- ---------------------------------------------------------------------------
-- Zonas y mesas (por sucursal)
-- ---------------------------------------------------------------------------

CREATE TABLE restaurant_zones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  name          text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  -- Para que una mesa solo pueda estar en una zona de su misma sucursal.
  UNIQUE (restaurant_id, branch_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX restaurant_zones_branch_idx ON restaurant_zones (restaurant_id, branch_id);

-- El estado libre/ocupada no se guarda: una mesa esta ocupada si tiene una
-- orden activa (ver el indice unico orders_one_active_per_table).
CREATE TABLE restaurant_tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  zone_id       uuid,
  name          text NOT NULL,
  capacity      integer NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 100),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, branch_id, id),
  UNIQUE (branch_id, name),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id, zone_id) REFERENCES restaurant_zones (restaurant_id, branch_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX restaurant_tables_branch_idx ON restaurant_tables (restaurant_id, branch_id);

-- ---------------------------------------------------------------------------
-- Metodos de pago y caja
-- ---------------------------------------------------------------------------

CREATE TABLE payment_methods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- efectivo: admite cambio y cuenta para el efectivo esperado en caja.
  kind          text NOT NULL DEFAULT 'otro' CHECK (kind IN ('efectivo', 'tarjeta', 'transferencia', 'otro')),
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);

-- Turno de caja por sucursal y terminal ("Caja 1", "Barra"...).
CREATE TABLE cash_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  terminal      text NOT NULL DEFAULT 'Caja 1',
  status        text NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'cerrada')),
  opening_cash  numeric(10,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  opened_by     uuid NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  -- Se llenan al cerrar (corte).
  expected_cash numeric(10,2),
  counted_cash  numeric(10,2),
  difference    numeric(10,2),
  total_sales   numeric(10,2),
  total_tips    numeric(10,2),
  orders_count  integer,
  closed_by     uuid,
  closed_at     timestamptz,
  notes         text,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, opened_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, closed_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX cash_sessions_branch_idx ON cash_sessions (restaurant_id, branch_id, opened_at DESC);
-- Solo un turno abierto por terminal de cada sucursal.
CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions (branch_id, lower(terminal)) WHERE status = 'abierta';

-- Entradas y salidas de efectivo durante el turno (fondo extra, compras...).
CREATE TABLE cash_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('entrada', 'salida')),
  amount        numeric(10,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, session_id) REFERENCES cash_sessions (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, created_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX cash_movements_session_idx ON cash_movements (restaurant_id, session_id);

-- Corte por metodo de pago: esperado (calculado) contra contado (capturado).
CREATE TABLE cash_session_counts (
  restaurant_id     uuid NOT NULL,
  session_id        uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  expected          numeric(10,2) NOT NULL,
  counted           numeric(10,2) NOT NULL CHECK (counted >= 0),
  difference        numeric(10,2) NOT NULL,
  PRIMARY KEY (session_id, payment_method_id),
  FOREIGN KEY (restaurant_id, session_id)        REFERENCES cash_sessions (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, payment_method_id) REFERENCES payment_methods (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX cash_session_counts_restaurant_idx ON cash_session_counts (restaurant_id);

-- ---------------------------------------------------------------------------
-- Ordenes
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id        uuid NOT NULL,
  -- Numero consecutivo por sucursal (lo asigna el backend).
  folio            integer NOT NULL,
  order_type       text NOT NULL CHECK (order_type IN ('comedor', 'para_llevar', 'domicilio')),
  table_id         uuid,
  guests           integer CHECK (guests IS NULL OR guests BETWEEN 1 AND 100),
  customer_name    text,
  customer_phone   text,
  customer_address text,
  notes            text,
  -- abierta -> enviada (a cocina) -> lista -> pagada; o cancelada (con motivo).
  status           text NOT NULL DEFAULT 'abierta'
                   CHECK (status IN ('abierta', 'enviada', 'lista', 'pagada', 'cancelada')),
  subtotal         numeric(10,2) NOT NULL DEFAULT 0,
  discount_type    text CHECK (discount_type IN ('amount', 'percent')),
  discount_value   numeric(10,2),
  discount_amount  numeric(10,2) NOT NULL DEFAULT 0,
  discount_reason  text,
  discount_by      uuid,
  tax_rate_pct     numeric(5,2) NOT NULL DEFAULT 0,
  prices_include_tax boolean NOT NULL DEFAULT true,
  tax_amount       numeric(10,2) NOT NULL DEFAULT 0,
  total            numeric(10,2) NOT NULL DEFAULT 0,
  paid_amount      numeric(10,2) NOT NULL DEFAULT 0,
  tip_amount       numeric(10,2) NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL,
  sent_at          timestamptz,
  ready_at         timestamptz,
  paid_at          timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  cancel_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (branch_id, folio),
  FOREIGN KEY (restaurant_id, branch_id)           REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, branch_id, table_id) REFERENCES restaurant_tables (restaurant_id, branch_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)          REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, discount_by)         REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, cancelled_by)        REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (order_type <> 'comedor' OR table_id IS NOT NULL),
  CHECK (status <> 'cancelada' OR cancel_reason IS NOT NULL)
);
CREATE INDEX orders_branch_status_idx ON orders (restaurant_id, branch_id, status);
CREATE INDEX orders_branch_created_idx ON orders (restaurant_id, branch_id, created_at DESC);
-- Una mesa solo puede tener una orden activa a la vez.
CREATE UNIQUE INDEX orders_one_active_per_table ON orders (table_id)
  WHERE table_id IS NOT NULL AND status IN ('abierta', 'enviada', 'lista');

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL,
  order_id        uuid NOT NULL,
  menu_item_id    uuid NOT NULL,
  -- Copia del nombre y precio al momento de la venta.
  name            text NOT NULL,
  unit_price      numeric(10,2) NOT NULL,
  modifiers_total numeric(10,2) NOT NULL DEFAULT 0, -- por unidad
  quantity        integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  line_total      numeric(10,2) NOT NULL,
  notes           text,
  sent_at         timestamptz,
  -- Articulo ya enviado a cocina que se cancela (no cuenta en el total).
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,
  created_by      uuid NOT NULL,
  -- clock_timestamp: varios articulos de la misma transaccion conservan su orden.
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_id)     REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, menu_item_id) REFERENCES menu_items (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, voided_by)    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)   REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX order_items_order_idx ON order_items (restaurant_id, order_id);

-- Copia de los modificadores elegidos. modifier_id es solo referencia (sin
-- FK) para que el catalogo se pueda editar o borrar sin tocar ventas
-- pasadas; el backend valida que pertenezca al restaurante al venderlo.
CREATE TABLE order_item_modifiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  modifier_id   uuid,
  group_name    text NOT NULL,
  name          text NOT NULL,
  price_delta   numeric(10,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (restaurant_id, order_item_id) REFERENCES order_items (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX order_item_modifiers_item_idx ON order_item_modifiers (restaurant_id, order_item_id);

CREATE TABLE order_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL,
  order_id          uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  cash_session_id   uuid NOT NULL,
  -- amount: lo que se abona a la cuenta. tip: propina con este metodo.
  -- received: lo que entrego el cliente (solo efectivo); change_given = received - amount - tip.
  amount            numeric(10,2) NOT NULL CHECK (amount >= 0),
  tip               numeric(10,2) NOT NULL DEFAULT 0 CHECK (tip >= 0),
  received          numeric(10,2) NOT NULL CHECK (received >= 0),
  change_given      numeric(10,2) NOT NULL DEFAULT 0 CHECK (change_given >= 0),
  reference         text,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id, id),
  CHECK (amount + tip > 0),
  CHECK (received = amount + tip + change_given),
  FOREIGN KEY (restaurant_id, order_id)          REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, payment_method_id) REFERENCES payment_methods (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, cash_session_id)   REFERENCES cash_sessions (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)        REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX order_payments_order_idx ON order_payments (restaurant_id, order_id);
CREATE INDEX order_payments_session_idx ON order_payments (restaurant_id, cash_session_id);

-- ---------------------------------------------------------------------------
-- Valores iniciales por restaurante
-- ---------------------------------------------------------------------------

-- Configuracion y metodos de pago basicos. Idempotente: la llama el Panel al
-- crear un restaurante y esta migracion para los que ya existian.
CREATE OR REPLACE FUNCTION seed_pos_defaults(rid uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pos_settings (restaurant_id) VALUES (rid) ON CONFLICT DO NOTHING;
  INSERT INTO payment_methods (restaurant_id, name, kind, sort_order) VALUES
    (rid, 'Efectivo', 'efectivo', 10),
    (rid, 'Tarjeta', 'tarjeta', 20),
    (rid, 'Transferencia', 'transferencia', 30)
  ON CONFLICT (restaurant_id, name) DO NOTHING;
$$;

-- ---------------------------------------------------------------------------
-- RLS (misma politica que 003)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pos_settings', 'menu_categories', 'menu_items', 'menu_item_branches',
    'modifier_groups', 'modifiers', 'menu_item_modifier_groups',
    'restaurant_zones', 'restaurant_tables', 'payment_methods',
    'cash_sessions', 'cash_movements', 'cash_session_counts',
    'orders', 'order_items', 'order_item_modifiers', 'order_payments'
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

-- Restaurantes que ya existian: se siembran en contexto de plataforma (local
-- a la transaccion de esta migracion).
SELECT set_config('app.is_platform', 'on', true);
SELECT seed_pos_defaults(id) FROM restaurants;
