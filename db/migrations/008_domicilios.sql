-- 008: Domicilios (Fase 5, modulo 'domicilios').
--
-- Dos modos por restaurante (delivery_settings.mode):
--
-- A) propio: los repartidores son usuarios del restaurante con rol
--    'repartidor' (por sucursal). Tablas por restaurante (RLS de 003):
--    - order_deliveries: asignacion de un pedido a domicilio a un repartidor
--      y su estado (asignado -> recogido -> en_camino -> entregado, o
--      fallido con motivo / cancelado).
--    - driver_locations: ultima ubicacion de cada repartidor en turno.
--    - driver_cash_cuts: corte del repartidor (efectivo cobrado contra lo
--      entregado), que mete esos pagos al turno de caja abierto.
--    - order_payments: el efectivo que cobra el repartidor se registra como
--      pago (driver_user_id) sin turno de caja hasta su corte.
--
-- B) horom: flota de repartidores de la PLATAFORMA (de Alex). Tablas de
--    plataforma, que ningun restaurante lee completas:
--    - fleet_settings (una fila), fleet_drivers (con su propio login,
--      audiencia 'fleet'), fleet_driver_locations, fleet_driver_cuts.
--    - delivery_requests: solicitud de entrega de un restaurante con una
--      COPIA de lo minimo para entregar (sucursal, cliente, direccion,
--      efectivo a cobrar). El restaurante ve solo las suyas; el repartidor
--      de la flota solo las que tiene asignadas; el Panel todas.
--    - delivery_request_offers: oferta automatica a repartidores disponibles.
--    - fleet_settlements: liquidaciones al restaurante (efectivo cobrado por
--      la flota menos comisiones).
--    La comision por entrega (fija o % del subtotal) se cobra en la
--    siguiente factura mensual (linea "Domicilios Horom (N entregas)") o se
--    descuenta en una liquidacion; nunca en las dos.
--
-- Contexto RLS nuevo: app.fleet_driver_id (lo fija withFleetDriver). Con el
-- solo se ven las filas del propio repartidor de la flota; las tablas por
-- restaurante siguen cerradas (no hay app.restaurant_id).

CREATE OR REPLACE FUNCTION app_current_fleet_driver_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.fleet_driver_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Configuracion de domicilios del restaurante: el Panel es la autoridad
-- ---------------------------------------------------------------------------

ALTER TABLE delivery_settings
  -- Alex habilita el servicio de la flota para el restaurante. Sin esto el
  -- restaurante no puede elegir el modo 'horom'.
  ADD COLUMN horom_enabled boolean NOT NULL DEFAULT false;
UPDATE delivery_settings SET horom_enabled = true WHERE mode = 'horom';
ALTER TABLE delivery_settings
  ADD CONSTRAINT delivery_settings_horom_enabled CHECK (mode <> 'horom' OR horom_enabled);

-- Fuera del contexto de plataforma solo se puede cambiar el modo: la
-- habilitacion y la comision las fija el Panel.
CREATE OR REPLACE FUNCTION delivery_settings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_platform() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.horom_enabled OR NEW.horom_fee_value <> 0 OR NEW.horom_fee_type <> 'fixed' THEN
      RAISE EXCEPTION 'Solo NeuronPOS puede habilitar el servicio de repartidores' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.horom_enabled IS DISTINCT FROM OLD.horom_enabled
     OR NEW.horom_fee_type IS DISTINCT FROM OLD.horom_fee_type
     OR NEW.horom_fee_value IS DISTINCT FROM OLD.horom_fee_value THEN
    RAISE EXCEPTION 'Solo NeuronPOS puede cambiar las condiciones del servicio de repartidores' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER delivery_settings_guard BEFORE INSERT OR UPDATE ON delivery_settings
  FOR EACH ROW EXECUTE FUNCTION delivery_settings_guard();

-- ---------------------------------------------------------------------------
-- Flota de la plataforma
-- ---------------------------------------------------------------------------

-- Una sola fila (id = true).
CREATE TABLE fleet_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Pago al repartidor por entrega (si el repartidor no tiene uno propio).
  driver_pay_per_delivery numeric(10,2) NOT NULL DEFAULT 0 CHECK (driver_pay_per_delivery >= 0),
  -- Ofrecer cada solicitud nueva a los repartidores en turno y libres.
  auto_offer              boolean NOT NULL DEFAULT false,
  offer_seconds           integer NOT NULL DEFAULT 120 CHECK (offer_seconds BETWEEN 15 AND 3600),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_settings DEFAULT VALUES;

CREATE TABLE fleet_drivers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  phone            text NOT NULL,
  -- Login de la app /repartidor (audiencia 'fleet').
  email            citext NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  vehicle          text,
  plate            text,
  active           boolean NOT NULL DEFAULT true,
  -- NULL = el de fleet_settings.
  pay_per_delivery numeric(10,2) CHECK (pay_per_delivery IS NULL OR pay_per_delivery >= 0),
  on_duty          boolean NOT NULL DEFAULT false,
  notes            text,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Corte de efectivo de un repartidor de la flota (entrega a Alex lo cobrado).
CREATE TABLE fleet_driver_cuts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id        uuid NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  expected_cash    numeric(10,2) NOT NULL CHECK (expected_cash >= 0),
  counted_cash     numeric(10,2) NOT NULL CHECK (counted_cash >= 0),
  difference       numeric(10,2) NOT NULL,
  deliveries_count integer NOT NULL DEFAULT 0,
  notes            text,
  created_by       uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (difference = counted_cash - expected_cash)
);
CREATE INDEX fleet_driver_cuts_driver_idx ON fleet_driver_cuts (driver_id, created_at DESC);

-- Liquidacion a un restaurante: efectivo que la flota cobro a sus clientes
-- menos las comisiones que se descuentan aqui (esas ya no van a la factura).
CREATE TABLE fleet_settlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  cash_amount       numeric(10,2) NOT NULL CHECK (cash_amount >= 0),
  commission_amount numeric(10,2) NOT NULL CHECK (commission_amount >= 0),
  net_amount        numeric(10,2) NOT NULL CHECK (net_amount >= 0),
  deliveries_count  integer NOT NULL DEFAULT 0,
  method            text NOT NULL DEFAULT 'transferencia' CHECK (method IN ('transferencia', 'efectivo', 'otro')),
  reference         text,
  notes             text,
  created_by        uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK (net_amount = cash_amount - commission_amount)
);
CREATE INDEX fleet_settlements_restaurant_idx ON fleet_settlements (restaurant_id, created_at DESC);

CREATE TABLE delivery_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL,
  order_id           uuid NOT NULL,
  requested_by       uuid,
  -- Copia de lo minimo para entregar: el repartidor nunca lee tablas del restaurante.
  restaurant_name    text NOT NULL,
  order_folio        integer NOT NULL,
  pickup_name        text NOT NULL,
  pickup_address     text,
  pickup_phone       text,
  customer_name      text NOT NULL,
  customer_phone     text,
  dropoff_address    text NOT NULL,
  dropoff_reference  text,
  notes              text,
  order_subtotal     numeric(10,2) NOT NULL CHECK (order_subtotal >= 0),
  order_total        numeric(10,2) NOT NULL CHECK (order_total >= 0),
  -- Lo que el repartidor cobra en efectivo (0 = ya esta pagado).
  cash_to_collect    numeric(10,2) NOT NULL DEFAULT 0 CHECK (cash_to_collect >= 0),
  pay_with           numeric(10,2) CHECK (pay_with IS NULL OR pay_with >= 0),
  -- solicitado -> asignado -> recogido -> en_camino -> entregado; fallido o cancelado.
  status             text NOT NULL DEFAULT 'solicitado'
                     CHECK (status IN ('solicitado', 'asignado', 'recogido', 'en_camino', 'entregado', 'fallido', 'cancelado')),
  driver_id          uuid REFERENCES fleet_drivers(id) DEFERRABLE INITIALLY DEFERRED,
  driver_name        text,
  driver_phone       text,
  assigned_at        timestamptz,
  picked_up_at       timestamptz,
  on_way_at          timestamptz,
  delivered_at       timestamptz,
  failed_at          timestamptz,
  fail_reason        text,
  cancelled_at       timestamptz,
  cancel_reason      text,
  cash_collected     numeric(10,2) NOT NULL DEFAULT 0 CHECK (cash_collected >= 0),
  -- Comision copiada de delivery_settings al solicitar (el Panel la puede corregir).
  commission_type    text NOT NULL CHECK (commission_type IN ('fixed', 'percent')),
  commission_value   numeric(10,2) NOT NULL CHECK (commission_value >= 0),
  commission_amount  numeric(10,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  -- Pago al repartidor (se fija al entregar).
  driver_pay         numeric(10,2) NOT NULL DEFAULT 0 CHECK (driver_pay >= 0),
  -- La comision se cobra en una factura o se descuenta en una liquidacion.
  commission_invoice_id    uuid,
  commission_settlement_id uuid,
  -- El efectivo cobrado se entrega al restaurante en una liquidacion...
  cash_settlement_id uuid,
  -- ...y el repartidor se lo entrega a Alex en su corte.
  driver_cut_id      uuid REFERENCES fleet_driver_cuts(id) DEFERRABLE INITIALLY DEFERRED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id)    REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, order_id)     REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, requested_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, commission_invoice_id) REFERENCES subscription_invoices (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, commission_settlement_id) REFERENCES fleet_settlements (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, cash_settlement_id) REFERENCES fleet_settlements (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (commission_type <> 'percent' OR commission_value <= 100),
  CHECK (status IN ('solicitado', 'cancelado') OR driver_id IS NOT NULL),
  CHECK (status <> 'fallido' OR fail_reason IS NOT NULL),
  CHECK (commission_invoice_id IS NULL OR commission_settlement_id IS NULL)
);
CREATE INDEX delivery_requests_status_idx ON delivery_requests (status, created_at DESC);
CREATE INDEX delivery_requests_restaurant_idx ON delivery_requests (restaurant_id, created_at DESC);
CREATE INDEX delivery_requests_driver_idx ON delivery_requests (driver_id, status) WHERE driver_id IS NOT NULL;
-- Una sola solicitud vigente (o entregada) por pedido.
CREATE UNIQUE INDEX delivery_requests_one_active ON delivery_requests (order_id)
  WHERE status NOT IN ('fallido', 'cancelado');

-- Fuera del Panel nadie toca la comision, el repartidor asignado ni las
-- liquidaciones. Al solicitar, la comision debe ser la de delivery_settings.
CREATE OR REPLACE FUNCTION delivery_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s delivery_settings%ROWTYPE;
  expected numeric(10,2);
BEGIN
  IF app_is_platform() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO s FROM delivery_settings WHERE restaurant_id = NEW.restaurant_id;
    IF NOT FOUND OR NOT s.horom_enabled OR s.mode <> 'horom' THEN
      RAISE EXCEPTION 'El restaurante no tiene habilitado el servicio de repartidores' USING ERRCODE = '42501';
    END IF;
    expected := CASE WHEN s.horom_fee_type = 'fixed' THEN s.horom_fee_value
                     ELSE round(NEW.order_subtotal * s.horom_fee_value / 100, 2) END;
    IF NEW.driver_id IS NOT NULL OR NEW.status <> 'solicitado'
       OR NEW.commission_type <> s.horom_fee_type OR NEW.commission_value <> s.horom_fee_value
       OR NEW.commission_amount <> expected OR NEW.driver_pay <> 0 OR NEW.cash_collected <> 0
       OR NEW.commission_invoice_id IS NOT NULL OR NEW.commission_settlement_id IS NOT NULL
       OR NEW.cash_settlement_id IS NOT NULL OR NEW.driver_cut_id IS NOT NULL THEN
      RAISE EXCEPTION 'Solicitud de reparto invalida' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.commission_type IS DISTINCT FROM OLD.commission_type
     OR NEW.commission_value IS DISTINCT FROM OLD.commission_value
     OR NEW.commission_amount IS DISTINCT FROM OLD.commission_amount
     OR NEW.commission_invoice_id IS DISTINCT FROM OLD.commission_invoice_id
     OR NEW.commission_settlement_id IS DISTINCT FROM OLD.commission_settlement_id
     OR NEW.cash_settlement_id IS DISTINCT FROM OLD.cash_settlement_id
     OR NEW.driver_cut_id IS DISTINCT FROM OLD.driver_cut_id THEN
    RAISE EXCEPTION 'Solo NeuronPOS puede cambiar el repartidor, la comision o las liquidaciones' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER delivery_requests_guard BEFORE INSERT OR UPDATE ON delivery_requests
  FOR EACH ROW EXECUTE FUNCTION delivery_requests_guard();

CREATE TABLE delivery_request_offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
  driver_id    uuid NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  -- Resumen para decidir (restaurante, recoger en, entregar en, efectivo).
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'ofrecida' CHECK (status IN ('ofrecida', 'aceptada', 'rechazada', 'expirada')),
  expires_at   timestamptz NOT NULL,
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, driver_id)
);
CREATE INDEX delivery_request_offers_driver_idx ON delivery_request_offers (driver_id, status, expires_at);

-- Ultima ubicacion de cada repartidor de la flota.
CREATE TABLE fleet_driver_locations (
  driver_id   uuid PRIMARY KEY REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  latitude    numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m  numeric(8,1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Repartidores propios del restaurante
-- ---------------------------------------------------------------------------

CREATE TABLE order_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL,
  branch_id      uuid NOT NULL,
  driver_user_id uuid NOT NULL,
  -- asignado -> recogido -> en_camino -> entregado; fallido (con motivo) o cancelado.
  status         text NOT NULL DEFAULT 'asignado'
                 CHECK (status IN ('asignado', 'recogido', 'en_camino', 'entregado', 'fallido', 'cancelado')),
  -- Saldo de la cuenta al asignar (lo que hay que cobrar en la puerta).
  cash_to_collect numeric(10,2) NOT NULL DEFAULT 0 CHECK (cash_to_collect >= 0),
  cash_collected  numeric(10,2) NOT NULL DEFAULT 0 CHECK (cash_collected >= 0),
  fail_reason    text,
  cancel_reason  text,
  assigned_by    uuid,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  picked_up_at   timestamptz,
  on_way_at      timestamptz,
  delivered_at   timestamptz,
  failed_at      timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_id)       REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)      REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, driver_user_id) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, assigned_by)    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (status <> 'fallido' OR fail_reason IS NOT NULL)
);
CREATE INDEX order_deliveries_branch_idx ON order_deliveries (restaurant_id, branch_id, created_at DESC);
CREATE INDEX order_deliveries_driver_idx ON order_deliveries (restaurant_id, driver_user_id, status);
CREATE UNIQUE INDEX order_deliveries_one_active ON order_deliveries (order_id)
  WHERE status NOT IN ('fallido', 'cancelado');

-- Ultima ubicacion (y si esta en turno) de cada repartidor propio.
CREATE TABLE driver_locations (
  restaurant_id uuid NOT NULL,
  user_id       uuid PRIMARY KEY,
  on_duty       boolean NOT NULL DEFAULT false,
  latitude      numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude     numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m    numeric(8,1),
  located_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, user_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE,
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX driver_locations_restaurant_idx ON driver_locations (restaurant_id);

-- Corte del repartidor: el efectivo que cobro entra al turno de caja.
CREATE TABLE driver_cash_cuts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id        uuid NOT NULL,
  driver_user_id   uuid NOT NULL,
  cash_session_id  uuid NOT NULL,
  expected_cash    numeric(10,2) NOT NULL CHECK (expected_cash >= 0),
  counted_cash     numeric(10,2) NOT NULL CHECK (counted_cash >= 0),
  difference       numeric(10,2) NOT NULL,
  deliveries_count integer NOT NULL DEFAULT 0,
  notes            text,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK (difference = counted_cash - expected_cash),
  FOREIGN KEY (restaurant_id, branch_id)       REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, driver_user_id)  REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, cash_session_id) REFERENCES cash_sessions (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, created_by)      REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX driver_cash_cuts_branch_idx ON driver_cash_cuts (restaurant_id, branch_id, created_at DESC);

-- Pagos cobrados en la puerta:
--  - propio: driver_user_id = repartidor que trae el efectivo; sin turno de
--    caja hasta su corte (driver_cut_id), que le pone el turno.
--  - horom: delivery_request_id = solicitud de la flota; nunca entra a caja
--    (el dinero llega en una liquidacion).
ALTER TABLE order_payments
  ADD COLUMN driver_user_id uuid,
  ADD COLUMN driver_cut_id uuid,
  ADD COLUMN delivery_request_id uuid REFERENCES delivery_requests(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT order_payments_driver_fk FOREIGN KEY (restaurant_id, driver_user_id)
    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT order_payments_driver_cut_fk FOREIGN KEY (restaurant_id, driver_cut_id)
    REFERENCES driver_cash_cuts (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT order_payments_driver_cut_check CHECK (driver_cut_id IS NULL OR (driver_user_id IS NOT NULL AND cash_session_id IS NOT NULL));
ALTER TABLE order_payments DROP CONSTRAINT order_payments_origin;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_origin CHECK (
  clip_checkout_id IS NOT NULL
  OR delivery_request_id IS NOT NULL
  OR (created_by IS NOT NULL AND (cash_session_id IS NOT NULL OR driver_user_id IS NOT NULL))
);
CREATE INDEX order_payments_driver_pending_idx ON order_payments (restaurant_id, driver_user_id)
  WHERE driver_user_id IS NOT NULL AND driver_cut_id IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- Por restaurante: misma politica de 003.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_deliveries', 'driver_locations', 'driver_cash_cuts', 'fleet_settlements'] LOOP
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

-- Plataforma: el Panel todo; el repartidor de la flota solo lo suyo.
ALTER TABLE fleet_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON fleet_settings USING (app_is_platform()) WITH CHECK (app_is_platform());
CREATE POLICY fleet_read ON fleet_settings FOR SELECT USING (app_current_fleet_driver_id() IS NOT NULL);

ALTER TABLE fleet_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_drivers FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_isolation ON fleet_drivers
  USING (app_is_platform() OR id = app_current_fleet_driver_id())
  WITH CHECK (app_is_platform() OR id = app_current_fleet_driver_id());

ALTER TABLE fleet_driver_cuts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_driver_cuts FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_isolation ON fleet_driver_cuts
  USING (app_is_platform() OR driver_id = app_current_fleet_driver_id())
  WITH CHECK (app_is_platform());

ALTER TABLE delivery_request_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_request_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY fleet_isolation ON delivery_request_offers
  USING (app_is_platform() OR driver_id = app_current_fleet_driver_id())
  WITH CHECK (app_is_platform() OR driver_id = app_current_fleet_driver_id());

-- Solicitudes: el restaurante las suyas; el repartidor las que tiene asignadas.
ALTER TABLE delivery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY request_access ON delivery_requests
  USING (app_can_access(restaurant_id) OR (driver_id IS NOT NULL AND driver_id = app_current_fleet_driver_id()))
  WITH CHECK (app_can_access(restaurant_id) OR (driver_id IS NOT NULL AND driver_id = app_current_fleet_driver_id()));

-- Ubicacion de la flota: el Panel, el propio repartidor y el restaurante
-- SOLO mientras ese repartidor lleva una solicitud suya.
ALTER TABLE fleet_driver_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_driver_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY location_access ON fleet_driver_locations
  USING (
    app_is_platform()
    OR driver_id = app_current_fleet_driver_id()
    OR EXISTS (
      SELECT 1 FROM delivery_requests r
       WHERE r.driver_id = fleet_driver_locations.driver_id
         AND r.restaurant_id = app_current_restaurant_id()
         AND r.status IN ('asignado', 'recogido', 'en_camino')
    )
  )
  WITH CHECK (app_is_platform() OR driver_id = app_current_fleet_driver_id());
