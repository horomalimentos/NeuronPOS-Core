-- Nayo en vivo: cuando un repartidor se conecta o desconecta (o el Panel lo
-- aprueba o bloquea), o un restaurante publica, pausa o es aprobado, se avisa
-- por el canal en vivo (services/live.js) y la pagina de clientes de Nayo se
-- actualiza al instante. Postgres junta los avisos repetidos de una misma
-- transaccion, asi que un cambio masivo manda un solo aviso.
CREATE OR REPLACE FUNCTION nayo_notify_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('neuronpos_live', json_build_object('r', 'nayo', 'b', NULL, 't', TG_ARGV[0])::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER fleet_drivers_nayo_live AFTER UPDATE ON fleet_drivers
  FOR EACH ROW WHEN (
    NEW.on_duty IS DISTINCT FROM OLD.on_duty OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.active IS DISTINCT FROM OLD.active OR NEW.radius_km IS DISTINCT FROM OLD.radius_km
    OR NEW.base_latitude IS DISTINCT FROM OLD.base_latitude OR NEW.base_longitude IS DISTINCT FROM OLD.base_longitude
  ) EXECUTE FUNCTION nayo_notify_live('drivers');

CREATE TRIGGER marketplace_listings_nayo_live AFTER UPDATE ON marketplace_listings
  FOR EACH ROW WHEN (
    NEW.published IS DISTINCT FROM OLD.published OR NEW.paused_until IS DISTINCT FROM OLD.paused_until
    OR NEW.blocked IS DISTINCT FROM OLD.blocked OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
  ) EXECUTE FUNCTION nayo_notify_live('restaurants');
