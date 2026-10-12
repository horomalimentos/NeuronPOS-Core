-- 021: Herramientas de operacion del personal (como Horom), en el modulo "rh":
--
--  Checklists   plantillas (apertura, cierre, limpieza...) por sucursal y
--               area, con puntos que pueden pedir foto. Cada dia se llenan
--               (hr_checklist_runs) y se envian; el gerente ve el historial.
--  Incidencias  actas por empleado (retardo, falta, conducta, accidente...),
--               con fotos de evidencia; el empleado la firma con su usuario
--               y puede dejar su comentario.
--  Comunicados  avisos con prioridad, vigencia y a quien van (sucursal y/o
--               area); se registra quien los leyo.

CREATE TABLE hr_checklist_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  branch_id     uuid,
  area_id       uuid,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, area_id)   REFERENCES hr_areas (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE hr_checklist_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL,
  template_id    uuid NOT NULL,
  position       integer NOT NULL DEFAULT 0,
  text           text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  requires_photo boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, template_id) REFERENCES hr_checklist_templates (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX hr_checklist_items_template_idx ON hr_checklist_items (restaurant_id, template_id, position);

CREATE TABLE hr_checklist_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  template_id   uuid NOT NULL,
  branch_id     uuid NOT NULL,
  run_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'enviado')),
  notes         text,
  submitted_by  uuid,
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (template_id, branch_id, run_date),
  FOREIGN KEY (restaurant_id, template_id) REFERENCES hr_checklist_templates (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)   REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX hr_checklist_runs_branch_idx ON hr_checklist_runs (restaurant_id, branch_id, run_date DESC);

CREATE TABLE hr_checklist_run_items (
  restaurant_id uuid NOT NULL,
  run_id        uuid NOT NULL,
  item_id       uuid NOT NULL,
  done          boolean NOT NULL DEFAULT false,
  photo_url     text,
  note          text CHECK (note IS NULL OR length(note) <= 300),
  done_by       uuid,
  done_at       timestamptz,
  PRIMARY KEY (run_id, item_id),
  FOREIGN KEY (restaurant_id, run_id)  REFERENCES hr_checklist_runs (restaurant_id, id)  ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, item_id) REFERENCES hr_checklist_items (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX hr_checklist_run_items_restaurant_idx ON hr_checklist_run_items (restaurant_id);

CREATE TABLE hr_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('retardo', 'falta', 'conducta', 'accidente', 'otro')),
  occurred_on       date NOT NULL,
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  action_taken      text CHECK (action_taken IS NULL OR length(action_taken) <= 500),
  evidence          text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'firmada', 'cerrada')),
  employee_comment  text CHECK (employee_comment IS NULL OR length(employee_comment) <= 1000),
  employee_signed_at timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX hr_incidents_employee_idx ON hr_incidents (restaurant_id, employee_id, occurred_on DESC);

CREATE TABLE hr_announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'importante')),
  branch_id     uuid,
  area_id       uuid,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, area_id)   REFERENCES hr_areas (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hr_announcements_restaurant_idx ON hr_announcements (restaurant_id, starts_at DESC);

CREATE TABLE hr_announcement_reads (
  restaurant_id   uuid NOT NULL,
  announcement_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id),
  FOREIGN KEY (restaurant_id, announcement_id) REFERENCES hr_announcements (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, user_id)         REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX hr_announcement_reads_restaurant_idx ON hr_announcement_reads (restaurant_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_checklist_templates', 'hr_checklist_items', 'hr_checklist_runs', 'hr_checklist_run_items',
    'hr_incidents', 'hr_announcements', 'hr_announcement_reads'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))',
      t
    );
  END LOOP;
END
$$;
