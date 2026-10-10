-- 016: Zonas de entrega por distancia (modulo 'zonas_entrega'), adaptado
-- de Horom (clockLocations.js /delivery-zone, delivery_zone_tiers).
--
-- Por sucursal: un centro en el mapa y tramos de distancia con su tarifa
-- (p. ej. hasta 2 km $30, hasta 4 km $45). El cliente marca su domicilio en
-- el mapa; el servidor calcula la distancia en linea recta, cobra el tramo
-- que le toca y rechaza los domicilios fuera del tramo mas grande. Sin el
-- modulo (o sin zona) se sigue cobrando la tarifa fija de la sucursal.

CREATE TABLE branch_delivery_zones (
  restaurant_id    uuid NOT NULL,
  branch_id        uuid PRIMARY KEY,
  center_latitude  numeric(9,6) NOT NULL CHECK (center_latitude BETWEEN -90 AND 90),
  center_longitude numeric(9,6) NOT NULL CHECK (center_longitude BETWEEN -180 AND 180),
  -- [{ "radius_km": 2, "fee": 30 }, ...] ordenados por radio (los valida el backend).
  tiers            jsonb NOT NULL CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) BETWEEN 1 AND 10),
  -- Pedido minimo para domicilio en esta sucursal (ademas del general).
  min_order        numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  active           boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX branch_delivery_zones_restaurant_idx ON branch_delivery_zones (restaurant_id);

-- Punto del domicilio (pin en el mapa).
ALTER TABLE customer_addresses
  ADD COLUMN latitude  numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT customer_addresses_point CHECK ((latitude IS NULL) = (longitude IS NULL));

ALTER TABLE orders
  ADD COLUMN delivery_latitude    numeric(9,6) CHECK (delivery_latitude BETWEEN -90 AND 90),
  ADD COLUMN delivery_longitude   numeric(9,6) CHECK (delivery_longitude BETWEEN -180 AND 180),
  ADD COLUMN delivery_distance_km numeric(6,2) CHECK (delivery_distance_km >= 0),
  ADD CONSTRAINT orders_delivery_point CHECK ((delivery_latitude IS NULL) = (delivery_longitude IS NULL));

ALTER TABLE branch_delivery_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_delivery_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_delivery_zones
  USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('zonas_entrega', 'Zonas de entrega',
   'El cliente marca su domicilio en el mapa y el envío se cobra por distancia (tramos de km con su tarifa); no se aceptan domicilios fuera de la zona.', 80, 32)
ON CONFLICT (code) DO NOTHING;
