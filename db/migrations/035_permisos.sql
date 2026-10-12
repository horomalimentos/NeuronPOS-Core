-- 020: Permisos por rol editables por restaurante (como la pantalla de
-- Permisos de Horom). Los roles base siguen fijos; cada restaurante puede
-- prender o apagar capacidades del POS por rol. Sin fila = valor por omision
-- (services/permissions.js). El administrador siempre puede todo.
CREATE TABLE role_permissions (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('gerente', 'cajero', 'mesero', 'cocina', 'repartidor')),
  capability    text NOT NULL CHECK (capability ~ '^[a-zA-Z]{2,40}$'),
  allowed       boolean NOT NULL,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, role, capability)
);
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
