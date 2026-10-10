-- 033: Bitacora de accesos del personal (como la de Horom): cada inicio de
-- sesion, correcto o fallido, con IP y navegador. La ve admin y gerente en Usuarios.

CREATE TABLE access_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id       uuid,
  email         citext NOT NULL,
  result        text NOT NULL CHECK (result IN ('ok', 'contrasena', 'desactivada')),
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, user_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX access_log_recent_idx ON access_log (restaurant_id, created_at DESC);

ALTER TABLE access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_log USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
