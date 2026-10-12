-- Nayo: notificaciones push del sistema para sus tres apps instalables.
-- * Cliente: su pedido fue aceptado, va en camino, se entrego, se rechazo o
--   se cancelo, y mensajes nuevos del chat.
-- * Restaurante (personal en Nayo › Pedidos): llego un pedido y mensajes.
-- * Repartidor: hay un pedido disponible en su zona, le cancelaron uno y
--   mensajes de su pedido.
-- Son de la plataforma (no dependen del modulo 'push' del restaurante).
-- Igual que en 015, los triggers encolan en la misma transaccion y el
-- backend manda despues del COMMIT (LISTEN 'nayo_push' + job de respaldo).

CREATE TABLE nayo_push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint      text NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh        text NOT NULL CHECK (length(p256dh) <= 200),
  auth          text NOT NULL CHECK (length(auth) <= 100),
  -- Exactamente uno: cliente, repartidor o personal de un restaurante.
  customer_id   uuid REFERENCES nayo_customers(id) ON DELETE CASCADE,
  driver_id     uuid REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id       uuid,
  -- Prefijo de las ligas del cliente: '' en elnayo.com, '/nayo' en neuronpos.app.
  link_base     text NOT NULL DEFAULT '' CHECK (link_base IN ('', '/nayo', '/delivery')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(customer_id, driver_id, user_id) = 1),
  CHECK ((user_id IS NULL) = (restaurant_id IS NULL)),
  FOREIGN KEY (restaurant_id, user_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX nayo_push_subscriptions_one ON nayo_push_subscriptions (endpoint, coalesce(customer_id, driver_id, user_id));
CREATE INDEX nayo_push_subscriptions_customer_idx ON nayo_push_subscriptions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX nayo_push_subscriptions_driver_idx ON nayo_push_subscriptions (driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX nayo_push_subscriptions_restaurant_idx ON nayo_push_subscriptions (restaurant_id) WHERE restaurant_id IS NOT NULL;

CREATE TABLE nayo_push_outbox (
  id                   bigserial PRIMARY KEY,
  marketplace_order_id uuid NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  -- cliente: aceptado, en_camino, entregado, rechazado, cancelado
  -- restaurante: nuevo_pedido; repartidores: disponible; repartidor: cancelado
  -- mensaje: a quien no lo escribio (sender)
  audience             text NOT NULL CHECK (audience IN ('cliente', 'restaurante', 'repartidores', 'repartidor')),
  kind                 text NOT NULL CHECK (kind IN ('aceptado', 'en_camino', 'entregado', 'rechazado', 'cancelado', 'nuevo_pedido', 'disponible', 'mensaje')),
  driver_id            uuid,
  message_id           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);
CREATE INDEX nayo_push_outbox_pending_idx ON nayo_push_outbox (id) WHERE sent_at IS NULL;

-- Los cambios llegan con la sesion del restaurante, del repartidor o de la
-- plataforma; el buzon es solo de la plataforma, asi que aqui se entra como
-- plataforma un momento y se regresa a la sesion de antes.
CREATE OR REPLACE FUNCTION nayo_push_enqueue(mid uuid, aud text, k text, did uuid DEFAULT NULL, msg uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  prev text := coalesce(current_setting('app.is_platform', true), '');
BEGIN
  PERFORM set_config('app.is_platform', 'on', true);
  IF aud = 'repartidor' AND did IS NULL THEN
    SELECT driver_id INTO did FROM marketplace_orders WHERE id = mid;
  END IF;
  IF EXISTS (SELECT 1 FROM nayo_push_subscriptions) AND (aud <> 'repartidor' OR did IS NOT NULL) THEN
    INSERT INTO nayo_push_outbox (marketplace_order_id, audience, kind, driver_id, message_id) VALUES (mid, aud, k, did, msg);
    PERFORM pg_notify('nayo_push', '');
  END IF;
  PERFORM set_config('app.is_platform', prev, true);
END
$$;

CREATE OR REPLACE FUNCTION marketplace_orders_push() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'nuevo' THEN
      PERFORM nayo_push_enqueue(NEW.id, 'restaurante', 'nuevo_pedido');
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  -- Pagado con tarjeta: hasta ahora el restaurante lo ve.
  IF OLD.status = 'pago_pendiente' AND NEW.status = 'nuevo' THEN
    PERFORM nayo_push_enqueue(NEW.id, 'restaurante', 'nuevo_pedido');
  ELSIF NEW.status = 'aceptado' THEN
    PERFORM nayo_push_enqueue(NEW.id, 'cliente', 'aceptado');
    IF NEW.driver_id IS NULL THEN
      PERFORM nayo_push_enqueue(NEW.id, 'repartidores', 'disponible');
    END IF;
  ELSIF NEW.status IN ('en_camino', 'entregado') THEN
    PERFORM nayo_push_enqueue(NEW.id, 'cliente', NEW.status);
  ELSIF NEW.status IN ('rechazado', 'cancelado') AND OLD.status <> 'pago_pendiente' THEN
    PERFORM nayo_push_enqueue(NEW.id, 'cliente', NEW.status);
    IF NEW.driver_id IS NOT NULL THEN
      PERFORM nayo_push_enqueue(NEW.id, 'repartidor', 'cancelado', NEW.driver_id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER marketplace_orders_push
  AFTER INSERT OR UPDATE OF status ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_push();

CREATE OR REPLACE FUNCTION marketplace_messages_push() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender <> 'cliente' THEN
    PERFORM nayo_push_enqueue(NEW.marketplace_order_id, 'cliente', 'mensaje', NULL, NEW.id);
  END IF;
  IF NEW.sender <> 'restaurante' THEN
    PERFORM nayo_push_enqueue(NEW.marketplace_order_id, 'restaurante', 'mensaje', NULL, NEW.id);
  END IF;
  IF NEW.sender <> 'repartidor' THEN
    PERFORM nayo_push_enqueue(NEW.marketplace_order_id, 'repartidor', 'mensaje', NULL, NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER marketplace_messages_push
  AFTER INSERT ON marketplace_messages
  FOR EACH ROW EXECUTE FUNCTION marketplace_messages_push();

-- Solo la plataforma (backend) lee y escribe.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['nayo_push_subscriptions', 'nayo_push_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_only ON %I USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END
$$;
