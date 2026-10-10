-- NeuronPOS Delivery (fase 4): chat de tres partes por pedido (cliente,
-- restaurante y repartidor). Se escribe mientras el pedido esta en curso; se
-- puede leer despues. El cliente entra con el token del seguimiento y el
-- repartidor solo si lleva el pedido (lo valida el servidor como plataforma);
-- el restaurante lee y escribe con RLS de su restaurante.

CREATE TABLE marketplace_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id uuid NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sender               text NOT NULL CHECK (sender IN ('cliente', 'restaurante', 'repartidor')),
  sender_name          text NOT NULL,
  user_id              uuid,
  driver_id            uuid REFERENCES fleet_drivers(id) ON DELETE SET NULL,
  body                 text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_messages_order_idx ON marketplace_messages (marketplace_order_id, created_at);

ALTER TABLE marketplace_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON marketplace_messages USING (app_is_platform()) WITH CHECK (app_is_platform());
-- El restaurante: solo los de sus pedidos y solo como 'restaurante'.
CREATE POLICY restaurant_read ON marketplace_messages FOR SELECT USING (app_can_access(restaurant_id));
CREATE POLICY restaurant_write ON marketplace_messages FOR INSERT
  WITH CHECK (app_can_access(restaurant_id) AND sender = 'restaurante');
