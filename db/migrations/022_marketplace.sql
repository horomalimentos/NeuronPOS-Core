-- NeuronPOS Delivery (fase 1: base). Plataforma de pedidos local, estilo
-- Uber Eats / DiDi Food, sin mensualidad para restaurantes ni repartidores.
--
--   - marketplace_settings (una fila): reparto del costo de envio entre el
--     repartidor y NeuronPOS (inicia 80 / 20), comision sobre la comida
--     (inicia en 0), distancia maxima, tope de adeudo del repartidor.
--   - marketplace_fee_tiers: costo de envio por distancia (hasta N km).
--   - fleet_drivers: los repartidores se registran solos con su epicentro y
--     los km a la redonda que quieren cubrir; el Panel los aprueba. Solo un
--     repartidor aprobado puede ponerse en turno.
--   - marketplace_listings: la ficha de cada sucursal en NeuronPOS Delivery
--     (ubicacion, descripcion, publicada, pausa). La lee el sitio publico
--     como plataforma; el restaurante solo la suya.
--   - Modulo 'marketplace' ($0): el restaurante que se registra en Delivery
--     lo tiene; da acceso al menu y a su ficha sin contratar el POS.

CREATE TABLE marketplace_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled              boolean NOT NULL DEFAULT true,
  -- Del costo de envio: % para el repartidor; el resto es de NeuronPOS.
  driver_share_pct     numeric(5,2) NOT NULL DEFAULT 80 CHECK (driver_share_pct BETWEEN 0 AND 100),
  -- Comision de NeuronPOS sobre la comida (0 = el restaurante recibe todo).
  food_commission_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (food_commission_pct BETWEEN 0 AND 50),
  -- Mas lejos que esto no se muestra el restaurante ni se cobra envio.
  max_distance_km      numeric(5,2) NOT NULL DEFAULT 10 CHECK (max_distance_km > 0 AND max_distance_km <= 50),
  -- Con este adeudo (o mas) el repartidor ya no recibe pedidos en efectivo.
  driver_debt_limit    numeric(10,2) NOT NULL DEFAULT 300 CHECK (driver_debt_limit >= 0),
  -- Radio que puede elegir un repartidor.
  driver_max_radius_km numeric(5,2) NOT NULL DEFAULT 15 CHECK (driver_max_radius_km > 0 AND driver_max_radius_km <= 50),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO marketplace_settings DEFAULT VALUES;

CREATE TABLE marketplace_fee_tiers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  up_to_km   numeric(5,2) NOT NULL UNIQUE CHECK (up_to_km > 0 AND up_to_km <= 50),
  fee        numeric(10,2) NOT NULL CHECK (fee >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO marketplace_fee_tiers (up_to_km, fee) VALUES (3, 35), (5, 45), (8, 60), (10, 75);

-- Repartidores: alta propia y zona de trabajo.
ALTER TABLE fleet_drivers
  ADD COLUMN status          text NOT NULL DEFAULT 'aprobado'
                             CHECK (status IN ('pendiente', 'aprobado', 'rechazado', 'bloqueado')),
  ADD COLUMN self_registered boolean NOT NULL DEFAULT false,
  ADD COLUMN base_latitude   numeric(9,6) CHECK (base_latitude BETWEEN -90 AND 90),
  ADD COLUMN base_longitude  numeric(9,6) CHECK (base_longitude BETWEEN -180 AND 180),
  ADD COLUMN radius_km       numeric(5,2) CHECK (radius_km > 0 AND radius_km <= 50),
  ADD COLUMN review_note     text,
  ADD COLUMN reviewed_at     timestamptz,
  ADD CONSTRAINT fleet_drivers_base_point CHECK ((base_latitude IS NULL) = (base_longitude IS NULL)),
  ADD CONSTRAINT fleet_drivers_duty_approved CHECK (NOT on_duty OR status = 'aprobado');
CREATE INDEX fleet_drivers_status_idx ON fleet_drivers (status);

-- El repartidor puede editar su perfil y zona, nunca su propia aprobacion.
CREATE OR REPLACE FUNCTION fleet_drivers_guard_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_is_platform() AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.active IS DISTINCT FROM OLD.active
       OR NEW.pay_per_delivery IS DISTINCT FROM OLD.pay_per_delivery) THEN
    RAISE EXCEPTION 'Solo el Panel puede cambiar el estado del repartidor' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fleet_drivers_guard_status BEFORE UPDATE ON fleet_drivers
  FOR EACH ROW EXECUTE FUNCTION fleet_drivers_guard_status();

-- Ficha de una sucursal en NeuronPOS Delivery.
CREATE TABLE marketplace_listings (
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id      uuid PRIMARY KEY,
  latitude       numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude      numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  description    text,
  cuisine        text,
  cover_url      text,
  prep_minutes   integer NOT NULL DEFAULT 25 CHECK (prep_minutes BETWEEN 5 AND 180),
  min_order      numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  -- El restaurante decide si aparece; puede pausar pedidos un rato.
  published      boolean NOT NULL DEFAULT false,
  paused_until   timestamptz,
  -- El Panel puede ocultarlo (queja, menu falso...).
  blocked        boolean NOT NULL DEFAULT false,
  blocked_reason text,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, branch_id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  CONSTRAINT marketplace_listings_point CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT marketplace_listings_published_point CHECK (NOT published OR latitude IS NOT NULL)
);
CREATE INDEX marketplace_listings_restaurant_idx ON marketplace_listings (restaurant_id);

ALTER TABLE marketplace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON marketplace_settings USING (app_is_platform()) WITH CHECK (app_is_platform());
CREATE POLICY fleet_read ON marketplace_settings FOR SELECT USING (app_current_fleet_driver_id() IS NOT NULL);

ALTER TABLE marketplace_fee_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_fee_tiers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON marketplace_fee_tiers USING (app_is_platform()) WITH CHECK (app_is_platform());
CREATE POLICY fleet_read ON marketplace_fee_tiers FOR SELECT USING (app_current_fleet_driver_id() IS NOT NULL);

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketplace_listings
  USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));

-- El restaurante no puede quitarse un bloqueo del Panel.
CREATE OR REPLACE FUNCTION marketplace_listings_guard_block() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_is_platform() AND (NEW.blocked IS DISTINCT FROM OLD.blocked
       OR NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason) THEN
    RAISE EXCEPTION 'Solo el Panel puede bloquear o desbloquear la ficha' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER marketplace_listings_guard_block BEFORE UPDATE ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION marketplace_listings_guard_block();

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('marketplace', 'NeuronPOS Delivery',
   'Tu restaurante aparece en NeuronPOS Delivery, la plataforma local de pedidos a domicilio: los clientes cercanos ven tu menú y piden, y los repartidores de la plataforma entregan. Sin mensualidad.', 0, 38)
ON CONFLICT (code) DO NOTHING;
