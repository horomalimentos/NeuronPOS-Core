-- 009: Estaciones de cocina (barra, parrilla, sushi...).
--
-- Cada categoria puede tener una estacion por omision y cada producto puede
-- cambiarla. Al agregar un articulo a una orden se guarda su estacion en la
-- linea (order_items.station_id), asi cambiar el menu despues no mueve lo que
-- ya esta en cocina. Sin estacion = cocina general.
--
-- Cada estacion marca listo lo suyo: order_items.ready_at. La orden queda
-- lista (orders.ready_at / status 'lista') cuando ya no le queda nada enviado
-- pendiente en ninguna estacion.

CREATE TABLE kitchen_stations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE UNIQUE INDEX kitchen_stations_name_idx ON kitchen_stations (restaurant_id, lower(name));

ALTER TABLE menu_categories ADD COLUMN station_id uuid;
ALTER TABLE menu_categories ADD FOREIGN KEY (restaurant_id, station_id)
  REFERENCES kitchen_stations (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED;

-- NULL = la de su categoria.
ALTER TABLE menu_items ADD COLUMN station_id uuid;
ALTER TABLE menu_items ADD FOREIGN KEY (restaurant_id, station_id)
  REFERENCES kitchen_stations (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE order_items ADD COLUMN station_id uuid;
ALTER TABLE order_items ADD FOREIGN KEY (restaurant_id, station_id)
  REFERENCES kitchen_stations (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE order_items ADD COLUMN ready_at timestamptz;
CREATE INDEX order_items_kitchen_idx ON order_items (restaurant_id, order_id)
  WHERE sent_at IS NOT NULL AND ready_at IS NULL AND voided_at IS NULL;

-- Lo que ya estaba listo antes de esta migracion.
SELECT set_config('app.is_platform', 'on', true);
UPDATE order_items i SET ready_at = o.ready_at
  FROM orders o
 WHERE o.id = i.order_id AND o.restaurant_id = i.restaurant_id
   AND o.ready_at IS NOT NULL AND i.sent_at IS NOT NULL AND i.sent_at <= o.ready_at;

ALTER TABLE kitchen_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_stations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kitchen_stations
  USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
