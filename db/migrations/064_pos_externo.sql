-- 064: Restaurantes de Nayo conectados a su propio POS (por ahora, Horom).
--
-- * external_pos_links: que restaurante/sucursal de NeuronPOS es el espejo
--   de que sucursal del POS externo, y a que URL se le habla. Solo la
--   plataforma la lee o la cambia (la URL no la puede poner un restaurante).
--   La clave compartida va en el .env (EXTERNAL_POS_KEY_<PROVIDER>), no aqui.
-- * external_id en el menu: el id del producto/grupo/opcion en el POS
--   externo. El menu de NeuronPOS se copia de alla (services/externalPos.js)
--   y los pedidos se reenvian con esos ids.
-- * marketplace_orders.external_*: el pedido ya creado en el POS externo
--   (para no mandarlo dos veces) y el ultimo error al reenviarlo.

CREATE TABLE external_pos_links (
  restaurant_id      uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL,
  provider           text NOT NULL CHECK (provider IN ('horom')),
  base_url           text NOT NULL CHECK (base_url ~ '^https?://' AND length(base_url) <= 300),
  -- De donde se sirven las fotos del menu (base_url suele ser localhost).
  public_url         text CHECK (public_url ~ '^https://' AND length(public_url) <= 300),
  external_branch_id text NOT NULL CHECK (length(external_branch_id) <= 100),
  active             boolean NOT NULL DEFAULT true,
  menu_synced_at     timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);

ALTER TABLE external_pos_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_pos_links FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON external_pos_links USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE menu_categories ADD COLUMN external_id text;
ALTER TABLE menu_items      ADD COLUMN external_id text;
ALTER TABLE modifier_groups ADD COLUMN external_id text;
ALTER TABLE modifiers       ADD COLUMN external_id text;
CREATE UNIQUE INDEX menu_categories_external_idx ON menu_categories (restaurant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX menu_items_external_idx      ON menu_items (restaurant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX modifier_groups_external_idx ON modifier_groups (restaurant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX modifiers_external_idx       ON modifiers (restaurant_id, group_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE marketplace_orders
  ADD COLUMN external_order_id     text,
  ADD COLUMN external_order_number text,
  ADD COLUMN external_sent_at      timestamptz,
  ADD COLUMN external_attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN external_error        text;
