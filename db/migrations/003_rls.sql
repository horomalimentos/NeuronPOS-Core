-- 003: Row Level Security para las tablas por restaurante.
--
-- Cada request del backend abre una transaccion y ejecuta
--   SELECT set_config('app.restaurant_id', '<uuid>', true)
-- (o 'app.is_platform' = 'on' para el Panel NeuronPOS). Al ser "local" el
-- valor muere con el COMMIT/ROLLBACK, asi que una conexion del pool nunca
-- arrastra el restaurante de un request anterior.
--
-- Si una consulta corre fuera de ese contexto, las politicas no regresan
-- filas y rechazan escrituras (falla cerrado).
--
-- FORCE ROW LEVEL SECURITY hace que las politicas apliquen tambien al dueno
-- de las tablas (normalmente el mismo usuario con el que corre la app). Un
-- SUPERUSER o un rol con BYPASSRLS se las salta siempre: la app NO debe
-- conectarse con un rol asi (el servidor lo revisa al arrancar).

CREATE OR REPLACE FUNCTION app_current_restaurant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.restaurant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_platform', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION app_can_access(rid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_platform() OR rid = app_current_restaurant_id()
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_modules', 'delivery_settings', 'branches', 'users',
    'user_branches', 'subscription_invoices'
  ] LOOP
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
