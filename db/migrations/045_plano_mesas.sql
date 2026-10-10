-- 036: Plano de mesas por zona (como el editor de plano de Horom). Cuadricula
-- con las mesas acomodadas (posicion, tamano y forma) y elementos del local
-- (barra, pared, puerta, banos, caja, plantas, texto). La caja puede ver el
-- plano con el estado de cada mesa.

ALTER TABLE restaurant_zones
  ADD COLUMN map_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN map_width   integer NOT NULL DEFAULT 24 CHECK (map_width BETWEEN 8 AND 60),
  ADD COLUMN map_height  integer NOT NULL DEFAULT 16 CHECK (map_height BETWEEN 6 AND 60);

-- Posicion en celdas de la cuadricula (NULL = aun no se acomoda en el plano).
ALTER TABLE restaurant_tables
  ADD COLUMN map_x      integer CHECK (map_x IS NULL OR map_x BETWEEN 0 AND 59),
  ADD COLUMN map_y      integer CHECK (map_y IS NULL OR map_y BETWEEN 0 AND 59),
  ADD COLUMN map_w      integer NOT NULL DEFAULT 2 CHECK (map_w BETWEEN 1 AND 12),
  ADD COLUMN map_h      integer NOT NULL DEFAULT 2 CHECK (map_h BETWEEN 1 AND 12),
  ADD COLUMN map_shape  text NOT NULL DEFAULT 'cuadrada' CHECK (map_shape IN ('cuadrada', 'redonda'));

CREATE TABLE zone_map_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  zone_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('barra', 'pared', 'puerta', 'bano', 'caja', 'cocina', 'planta', 'texto')),
  label         text CHECK (label IS NULL OR length(label) <= 40),
  x             integer NOT NULL CHECK (x BETWEEN 0 AND 59),
  y             integer NOT NULL CHECK (y BETWEEN 0 AND 59),
  w             integer NOT NULL DEFAULT 2 CHECK (w BETWEEN 1 AND 60),
  h             integer NOT NULL DEFAULT 1 CHECK (h BETWEEN 1 AND 60),
  FOREIGN KEY (restaurant_id, branch_id, zone_id) REFERENCES restaurant_zones (restaurant_id, branch_id, id) ON DELETE CASCADE
);
CREATE INDEX zone_map_objects_zone_idx ON zone_map_objects (restaurant_id, zone_id);

ALTER TABLE zone_map_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone_map_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zone_map_objects USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
