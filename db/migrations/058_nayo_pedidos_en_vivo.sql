-- Pantalla de pedidos de Nayo del restaurante en vivo: cuando entra un pedido
-- o cambia (aceptado, listo, repartidor asignado, recogido, entregado) avisa a
-- las pantallas de esa sucursal por el canal de services/live.js.
CREATE OR REPLACE FUNCTION marketplace_orders_notify_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('neuronpos_live', json_build_object('r', NEW.restaurant_id, 'b', NEW.branch_id, 't', 'orders')::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER marketplace_orders_live_insert AFTER INSERT ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_notify_live();

CREATE TRIGGER marketplace_orders_live_update AFTER UPDATE ON marketplace_orders
  FOR EACH ROW WHEN (
    NEW.status IS DISTINCT FROM OLD.status OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
    OR NEW.picked_up_at IS DISTINCT FROM OLD.picked_up_at OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
  ) EXECUTE FUNCTION marketplace_orders_notify_live();
