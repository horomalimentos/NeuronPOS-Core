-- 011: Inventario (modulo 'inventario'), adaptado del de Horom.
--
-- - inv_areas: estaciones de conteo (almacen, cocina, barra...).
-- - inv_suppliers: proveedores.
-- - inv_products: insumos. Toda cantidad se guarda en la unidad base del
--   insumo (kg, litro, pieza...); inv_product_units define otras unidades con
--   su factor (1 caja = 12 piezas) para contar, comprar o usar en recetas.
--   count_days: dias de la semana en que se cuenta (ISO 1=lunes..7; NULL =
--   diario). requires_photo: foto obligatoria al contarlo (insumos caros).
--   daily_use: consumo diario esperado, para sugerir pedidos.
--   min_stock: existencia minima (alerta "por debajo del minimo").
-- - inv_stock: existencia actual por sucursal e insumo (la mantiene el backend
--   junto con cada movimiento).
-- - inv_movements: kardex. Cada cambio de existencia queda aqui con su motivo:
--   conteo (ajuste al contar), compra (recepcion), venta (descuento por
--   receta al cobrar), merma, ajuste manual o cancelacion de venta.
-- - inv_counts / inv_count_items: conteo fisico por sucursal, area y fecha;
--   se puede pausar y retomar. Al completarlo, la existencia pasa a ser lo
--   contado y la diferencia queda como movimiento 'conteo'.
-- - inv_recipe_items: receta de un producto del menu (insumo y cantidad por
--   unidad vendida). inv_modifier_recipe_items: receta de un modificador;
--   con menu_item_id es solo para ese producto y sustituye a la general.
-- - inv_purchase_orders / items: solicitudes y ordenes de compra por
--   proveedor (solicitada -> aprobada -> recibida, o cancelada). Recibir
--   suma a la existencia y guarda el precio (inv_price_history).
-- - inv_settings: descontar automaticamente por receta al cobrar.

-- ---------------------------------------------------------------------------
-- Catalogos
-- ---------------------------------------------------------------------------

CREATE TABLE inv_settings (
  restaurant_id    uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  deduct_on_sale   boolean NOT NULL DEFAULT true,
  -- Dias de inventario que se busca tener al sugerir un pedido.
  order_cover_days integer NOT NULL DEFAULT 3 CHECK (order_cover_days BETWEEN 1 AND 60),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inv_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE UNIQUE INDEX inv_areas_name_idx ON inv_areas (restaurant_id, lower(name)) WHERE active;

CREATE TABLE inv_suppliers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  contact_name  text,
  phone         text,
  email         text,
  notes         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE UNIQUE INDEX inv_suppliers_name_idx ON inv_suppliers (restaurant_id, lower(name)) WHERE active;

CREATE TABLE inv_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  category       text,
  base_unit      text NOT NULL,
  area_id        uuid,
  supplier_id    uuid,
  -- Costo por unidad base (ultimo precio de compra, o capturado a mano).
  unit_cost      numeric(12,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  min_stock      numeric(14,4) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  daily_use      numeric(14,4) NOT NULL DEFAULT 0 CHECK (daily_use >= 0),
  count_days     smallint[] CHECK (count_days IS NULL OR count_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  requires_photo boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, area_id)     REFERENCES inv_areas (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, supplier_id) REFERENCES inv_suppliers (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX inv_products_name_idx ON inv_products (restaurant_id, lower(name)) WHERE active;
CREATE INDEX inv_products_area_idx ON inv_products (restaurant_id, area_id);

-- Unidades alternas: 1 <name> = factor unidades base.
CREATE TABLE inv_product_units (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  product_id    uuid NOT NULL,
  name          text NOT NULL,
  factor        numeric(14,6) NOT NULL CHECK (factor > 0),
  -- Unidad en la que normalmente se compra (sugerencias y ordenes).
  is_purchase   boolean NOT NULL DEFAULT false,
  UNIQUE (restaurant_id, id),
  UNIQUE (product_id, name),
  FOREIGN KEY (restaurant_id, product_id) REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX inv_product_units_restaurant_idx ON inv_product_units (restaurant_id, product_id);

-- ---------------------------------------------------------------------------
-- Existencias y kardex
-- ---------------------------------------------------------------------------

CREATE TABLE inv_stock (
  restaurant_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  product_id    uuid NOT NULL,
  quantity      numeric(14,4) NOT NULL DEFAULT 0,
  last_count_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, product_id),
  FOREIGN KEY (restaurant_id, branch_id)  REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX inv_stock_restaurant_idx ON inv_stock (restaurant_id, branch_id);

CREATE TABLE inv_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  product_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('conteo', 'compra', 'venta', 'cancelacion', 'merma', 'ajuste')),
  -- Cambio en unidad base (+ entra, - sale) y existencia que quedo.
  quantity      numeric(14,4) NOT NULL,
  balance       numeric(14,4) NOT NULL,
  unit_cost     numeric(12,4),
  reason        text,
  order_id      uuid,
  count_id      uuid,
  purchase_order_id uuid,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id, branch_id)  REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, created_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX inv_movements_product_idx ON inv_movements (restaurant_id, branch_id, product_id, created_at DESC);
CREATE INDEX inv_movements_created_idx ON inv_movements (restaurant_id, created_at DESC);
CREATE INDEX inv_movements_order_idx ON inv_movements (order_id) WHERE order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Conteos fisicos
-- ---------------------------------------------------------------------------

CREATE TABLE inv_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  -- NULL = todas las areas.
  area_id       uuid,
  count_date    date NOT NULL,
  status        text NOT NULL DEFAULT 'en_progreso' CHECK (status IN ('en_progreso', 'pausado', 'completado', 'cancelado')),
  notes         text,
  created_by    uuid NOT NULL,
  completed_by  uuid,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id)    REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, area_id)      REFERENCES inv_areas (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)   REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, completed_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX inv_counts_branch_idx ON inv_counts (restaurant_id, branch_id, count_date DESC);
-- Un solo conteo abierto por sucursal, area y fecha (como en Horom).
CREATE UNIQUE INDEX inv_counts_one_open ON inv_counts (branch_id, coalesce(area_id, '00000000-0000-0000-0000-000000000000'::uuid), count_date)
  WHERE status IN ('en_progreso', 'pausado');

CREATE TABLE inv_count_items (
  restaurant_id uuid NOT NULL,
  count_id      uuid NOT NULL,
  product_id    uuid NOT NULL,
  -- Lo que capturo la persona y su equivalente en unidad base.
  entered_quantity numeric(14,4) NOT NULL CHECK (entered_quantity >= 0),
  entered_unit  text NOT NULL,
  quantity      numeric(14,4) NOT NULL CHECK (quantity >= 0),
  -- Existencia segun el sistema al momento de completar.
  expected      numeric(14,4),
  photo_url     text,
  counted_by    uuid NOT NULL,
  counted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (count_id, product_id),
  FOREIGN KEY (restaurant_id, count_id)   REFERENCES inv_counts (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id) REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, counted_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX inv_count_items_restaurant_idx ON inv_count_items (restaurant_id, count_id);

-- ---------------------------------------------------------------------------
-- Recetas
-- ---------------------------------------------------------------------------

CREATE TABLE inv_recipe_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  menu_item_id  uuid NOT NULL,
  product_id    uuid NOT NULL,
  -- Por unidad vendida, en unidad base del insumo.
  quantity      numeric(14,4) NOT NULL CHECK (quantity > 0),
  UNIQUE (menu_item_id, product_id),
  FOREIGN KEY (restaurant_id, menu_item_id) REFERENCES menu_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id)   REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX inv_recipe_items_restaurant_idx ON inv_recipe_items (restaurant_id, menu_item_id);

CREATE TABLE inv_modifier_recipe_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  modifier_id   uuid NOT NULL,
  -- NULL = receta general del modificador; con valor, solo para ese producto
  -- (si existe, sustituye por completo a la general).
  menu_item_id  uuid,
  product_id    uuid NOT NULL,
  quantity      numeric(14,4) NOT NULL CHECK (quantity > 0),
  FOREIGN KEY (restaurant_id, modifier_id)  REFERENCES modifiers (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, menu_item_id) REFERENCES menu_items (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id)   REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inv_modifier_recipe_items_uniq ON inv_modifier_recipe_items
  (modifier_id, coalesce(menu_item_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id);
CREATE INDEX inv_modifier_recipe_items_restaurant_idx ON inv_modifier_recipe_items (restaurant_id, modifier_id);

-- ---------------------------------------------------------------------------
-- Compras
-- ---------------------------------------------------------------------------

CREATE TABLE inv_purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  supplier_id   uuid,
  folio         integer NOT NULL,
  status        text NOT NULL DEFAULT 'solicitada' CHECK (status IN ('solicitada', 'aprobada', 'recibida', 'cancelada')),
  notes         text,
  total         numeric(12,2) NOT NULL DEFAULT 0,
  -- Foto del ticket o factura del proveedor.
  receipt_url   text,
  created_by    uuid NOT NULL,
  approved_by   uuid,
  approved_at   timestamptz,
  received_by   uuid,
  received_at   timestamptz,
  cancelled_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, folio),
  FOREIGN KEY (restaurant_id, branch_id)   REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, supplier_id) REFERENCES inv_suppliers (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, approved_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, received_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX inv_purchase_orders_idx ON inv_purchase_orders (restaurant_id, status, created_at DESC);

CREATE TABLE inv_purchase_order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  product_id    uuid NOT NULL,
  unit_name     text NOT NULL,
  unit_factor   numeric(14,6) NOT NULL CHECK (unit_factor > 0),
  quantity      numeric(14,4) NOT NULL CHECK (quantity > 0),
  -- Precio por unit_name (estimado al pedir, real al recibir).
  unit_price    numeric(12,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  received_quantity numeric(14,4) CHECK (received_quantity IS NULL OR received_quantity >= 0),
  UNIQUE (purchase_order_id, product_id),
  FOREIGN KEY (restaurant_id, purchase_order_id) REFERENCES inv_purchase_orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, product_id)        REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX inv_purchase_order_items_restaurant_idx ON inv_purchase_order_items (restaurant_id, purchase_order_id);

CREATE TABLE inv_price_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  product_id    uuid NOT NULL,
  supplier_id   uuid,
  unit_name     text NOT NULL,
  unit_factor   numeric(14,6) NOT NULL,
  unit_price    numeric(12,4) NOT NULL,
  purchase_order_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, product_id)  REFERENCES inv_products (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, supplier_id) REFERENCES inv_suppliers (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX inv_price_history_idx ON inv_price_history (restaurant_id, product_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS y modulo
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inv_settings', 'inv_areas', 'inv_suppliers', 'inv_products', 'inv_product_units', 'inv_stock',
    'inv_movements', 'inv_counts', 'inv_count_items', 'inv_recipe_items', 'inv_modifier_recipe_items',
    'inv_purchase_orders', 'inv_purchase_order_items', 'inv_price_history'
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

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('inventario', 'Inventario y compras',
   'Insumos, recetas, conteos, mermas, existencias por sucursal, proveedores y órdenes de compra.', 250, 17)
ON CONFLICT (code) DO NOTHING;
