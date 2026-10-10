-- 015: Notificaciones push (modulo 'push'), adaptado de Horom
-- (pushSubscriptions.js, notificationService.js, orderReadyNotifier.js).
--
-- Llegan aunque la pagina este cerrada o el celular bloqueado:
-- * Al cliente: su pedido en linea fue aceptado, esta listo, va en camino,
--   fue rechazado o cancelado. Se activa desde el seguimiento del pedido
--   (invitado: solo ese pedido) o con sesion (todos sus pedidos).
-- * Al personal (administrador, gerente, cajero): llego un pedido en linea.
-- * Al repartidor propio: le asignaron un pedido.
--
-- Los avisos se generan con triggers en la misma transaccion que el cambio
-- (sin importar que ruta lo hizo) y quedan en push_outbox; el backend los
-- manda despues del COMMIT (LISTEN 'push_outbox' + un job de respaldo).
-- Solo se encolan si el restaurante tiene al menos una suscripcion.

CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  endpoint      text NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh        text NOT NULL CHECK (length(p256dh) <= 200),
  auth          text NOT NULL CHECK (length(auth) <= 100),
  -- Exactamente uno: personal, cliente con sesion o pedido de invitado.
  user_id       uuid,
  customer_id   uuid,
  order_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, customer_id, order_id) = 1),
  FOREIGN KEY (restaurant_id, user_id)     REFERENCES users (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, order_id)    REFERENCES orders (restaurant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX push_subscriptions_one ON push_subscriptions
  (restaurant_id, endpoint, coalesce(user_id, customer_id, order_id));
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (restaurant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX push_subscriptions_customer_idx ON push_subscriptions (restaurant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX push_subscriptions_order_idx ON push_subscriptions (restaurant_id, order_id) WHERE order_id IS NOT NULL;

CREATE TABLE push_outbox (
  id            bigserial PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- cliente: aceptado, listo, en_camino, rechazado, cancelado
  -- personal: nuevo_pedido; repartidor: asignado
  kind          text NOT NULL CHECK (kind IN ('aceptado', 'listo', 'en_camino', 'rechazado', 'cancelado', 'nuevo_pedido', 'asignado')),
  order_id      uuid NOT NULL,
  user_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX push_outbox_pending_idx ON push_outbox (id) WHERE sent_at IS NULL;

-- Ajustes de la plataforma: llaves VAPID generadas solas la primera vez
-- (la privada cifrada con PAYMENT_SECRETS_KEY); VAPID_* en .env tiene prioridad.
ALTER TABLE platform_settings
  ADD COLUMN vapid_public_key  text,
  ADD COLUMN vapid_private_enc text;

CREATE OR REPLACE FUNCTION push_enqueue(rid uuid, k text, oid uuid, uid uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE restaurant_id = rid) THEN
    RETURN;
  END IF;
  INSERT INTO push_outbox (restaurant_id, kind, order_id, user_id) VALUES (rid, k, oid, uid);
  PERFORM pg_notify('push_outbox', '');
END
$$;

CREATE OR REPLACE FUNCTION orders_push_events() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source <> 'web' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.online_payment_status IS DISTINCT FROM 'pendiente' THEN
      PERFORM push_enqueue(NEW.restaurant_id, 'nuevo_pedido', NEW.id);
    END IF;
    RETURN NULL;
  END IF;
  -- Pagado en linea: hasta ahora el restaurante lo ve.
  IF OLD.online_payment_status = 'pendiente' AND NEW.online_payment_status = 'pagado' THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'nuevo_pedido', NEW.id);
  END IF;
  IF NEW.online_status = 'aceptada' AND OLD.online_status IS DISTINCT FROM 'aceptada' THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'aceptado', NEW.id);
  ELSIF NEW.online_status = 'rechazada' AND OLD.online_status IS DISTINCT FROM 'rechazada' THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'rechazado', NEW.id);
  ELSIF NEW.status = 'cancelada' AND OLD.status <> 'cancelada' AND NEW.online_status = 'aceptada' THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'cancelado', NEW.id);
  END IF;
  IF NEW.status <> 'cancelada' AND NEW.ready_at IS NOT NULL AND OLD.ready_at IS NULL THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'listo', NEW.id);
  END IF;
  IF NEW.order_type = 'domicilio' AND NEW.status <> 'cancelada'
     AND NEW.dispatched_at IS NOT NULL AND OLD.dispatched_at IS NULL THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'en_camino', NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER orders_push_events
  AFTER INSERT OR UPDATE OF online_status, online_payment_status, status, ready_at, dispatched_at ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_push_events();

CREATE OR REPLACE FUNCTION deliveries_push_events() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.driver_user_id IS NOT NULL AND NEW.status = 'asignado'
     AND (TG_OP = 'INSERT' OR NEW.driver_user_id IS DISTINCT FROM OLD.driver_user_id) THEN
    PERFORM push_enqueue(NEW.restaurant_id, 'asignado', NEW.order_id, NEW.driver_user_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER deliveries_push_events
  AFTER INSERT OR UPDATE OF driver_user_id ON order_deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_push_events();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_subscriptions', 'push_outbox'] LOOP
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
  ('push', 'Notificaciones push',
   'Avisos al celular aunque la página esté cerrada: al cliente cuando su pedido se acepta, está listo o va en camino; al personal de cada pedido en línea; al repartidor cuando le asignan uno.', 100, 35)
ON CONFLICT (code) DO NOTHING;
