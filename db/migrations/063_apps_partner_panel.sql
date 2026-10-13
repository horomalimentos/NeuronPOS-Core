-- Apps instalables Nayo Partner (restaurante) y Panel (plataforma).
--
-- * nayo_online_minutes: un renglon por minuto que la sucursal estuvo
--   conectada en Nayo (pantalla de pedidos abierta, ficha publicada y sin
--   pausa). Con esto Partner muestra las horas conectado por dia.
-- * platform_push_subscriptions: avisos push del Panel al dueno de la
--   plataforma (restaurante o repartidor nuevo por revisar).

CREATE TABLE nayo_online_minutes (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  minute        timestamptz NOT NULL CHECK (date_trunc('minute', minute) = minute),
  PRIMARY KEY (branch_id, minute),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX nayo_online_minutes_restaurant_idx ON nayo_online_minutes (restaurant_id, minute);

ALTER TABLE nayo_online_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nayo_online_minutes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nayo_online_minutes
  USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));

CREATE TABLE platform_push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint   text NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh     text NOT NULL CHECK (length(p256dh) <= 200),
  auth       text NOT NULL CHECK (length(auth) <= 100),
  admin_id   uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint)
);

ALTER TABLE platform_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_push_subscriptions USING (app_is_platform()) WITH CHECK (app_is_platform());
