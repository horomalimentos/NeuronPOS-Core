-- NeuronPOS Delivery (fase 2: el cliente pide).
--
--   - orders.channel acepta 'marketplace': el pedido vive en el restaurante
--     como pedido en linea a domicilio (lo ven su POS y su panel de Delivery).
--   - marketplace_orders: la parte de la plataforma de cada pedido: el
--     envio calculado por km, su reparto (repartidor / NeuronPOS), el
--     seguimiento publico (token) y el estado de la entrega. La lee el
--     restaurante (solo los suyos) y el Panel; en la fase 3 tambien el
--     repartidor asignado.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_channel_check CHECK (channel IN ('web', 'whatsapp', 'marketplace'));

CREATE TABLE marketplace_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL,
  order_id        uuid NOT NULL,
  public_token    text NOT NULL UNIQUE,
  customer_name   text NOT NULL,
  customer_phone  text NOT NULL,
  address         text NOT NULL,
  reference       text,
  latitude        numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude       numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  distance_km     numeric(6,2) NOT NULL CHECK (distance_km >= 0),
  -- Envio y su reparto, copiados de los ajustes al pedir.
  delivery_fee    numeric(10,2) NOT NULL CHECK (delivery_fee >= 0),
  driver_share    numeric(10,2) NOT NULL CHECK (driver_share >= 0),
  platform_share  numeric(10,2) NOT NULL CHECK (platform_share >= 0),
  -- Comida (lo que se le paga al restaurante) y total que paga el cliente.
  food_total      numeric(10,2) NOT NULL CHECK (food_total >= 0),
  total           numeric(10,2) NOT NULL CHECK (total >= 0),
  payment_method  text NOT NULL CHECK (payment_method IN ('efectivo', 'tarjeta')),
  pay_with        numeric(10,2) CHECK (pay_with IS NULL OR pay_with >= 0),
  -- nuevo -> aceptado -> listo -> en_camino -> entregado; rechazado / cancelado.
  status          text NOT NULL DEFAULT 'nuevo'
                  CHECK (status IN ('nuevo', 'aceptado', 'listo', 'en_camino', 'entregado', 'rechazado', 'cancelado')),
  cancel_reason   text,
  driver_id       uuid REFERENCES fleet_drivers(id) DEFERRABLE INITIALLY DEFERRED,
  accepted_at     timestamptz,
  ready_at        timestamptz,
  picked_up_at    timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (order_id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, order_id)  REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  CHECK (delivery_fee = driver_share + platform_share),
  CHECK (status NOT IN ('rechazado', 'cancelado') OR cancel_reason IS NOT NULL)
);
CREATE INDEX marketplace_orders_branch_idx ON marketplace_orders (restaurant_id, branch_id, created_at DESC);
CREATE INDEX marketplace_orders_status_idx ON marketplace_orders (status, created_at DESC);

ALTER TABLE marketplace_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY marketplace_order_access ON marketplace_orders
  USING (app_can_access(restaurant_id) OR (driver_id IS NOT NULL AND driver_id = app_current_fleet_driver_id()))
  WITH CHECK (app_can_access(restaurant_id) OR (driver_id IS NOT NULL AND driver_id = app_current_fleet_driver_id()));

-- El restaurante no puede cambiar el envio ni su reparto (los fija la plataforma al pedir).
CREATE OR REPLACE FUNCTION marketplace_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_is_platform() AND (NEW.delivery_fee IS DISTINCT FROM OLD.delivery_fee
       OR NEW.driver_share IS DISTINCT FROM OLD.driver_share
       OR NEW.platform_share IS DISTINCT FROM OLD.platform_share
       OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.food_total IS DISTINCT FROM OLD.food_total) THEN
    RAISE EXCEPTION 'Solo la plataforma puede cambiar el envio, el total o el repartidor' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER marketplace_orders_guard BEFORE UPDATE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_guard();

-- El estado se sigue del pedido del restaurante, lo cambie su POS (pedidos
-- en linea, cocina) o su panel de Delivery: aceptar, rechazar, cancelar, listo.
CREATE OR REPLACE FUNCTION orders_marketplace_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM 'marketplace' THEN
    RETURN NULL;
  END IF;
  IF NEW.online_status = 'rechazada' AND OLD.online_status IS DISTINCT FROM 'rechazada' THEN
    UPDATE marketplace_orders SET status = 'rechazado', cancel_reason = coalesce(NEW.cancel_reason, 'Rechazado por el restaurante'),
           cancelled_at = now(), updated_at = now()
     WHERE order_id = NEW.id AND status IN ('nuevo', 'aceptado', 'listo');
  ELSIF NEW.status = 'cancelada' AND OLD.status IS DISTINCT FROM 'cancelada' THEN
    UPDATE marketplace_orders SET status = 'cancelado', cancel_reason = coalesce(NEW.cancel_reason, 'Cancelado por el restaurante'),
           cancelled_at = now(), updated_at = now()
     WHERE order_id = NEW.id AND status NOT IN ('entregado', 'rechazado', 'cancelado');
  ELSE
    IF NEW.online_status = 'aceptada' AND OLD.online_status IS DISTINCT FROM 'aceptada' THEN
      UPDATE marketplace_orders SET status = 'aceptado', accepted_at = now(), updated_at = now()
       WHERE order_id = NEW.id AND status = 'nuevo';
    END IF;
    IF NEW.ready_at IS NOT NULL AND OLD.ready_at IS NULL THEN
      UPDATE marketplace_orders SET status = 'listo', ready_at = now(), updated_at = now()
       WHERE order_id = NEW.id AND status IN ('nuevo', 'aceptado');
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER orders_marketplace_status
  AFTER UPDATE OF online_status, status, ready_at ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_marketplace_status();
