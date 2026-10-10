-- 018: Calificaciones y quejas de pedidos en linea (modulo 'quejas'),
-- adaptado de Horom (order_ratings, webComplaints.js, customerComplaintsAdmin.js).
--
-- * Calificacion: al recibir su pedido el cliente le da de 1 a 5 estrellas
--   (general, comida y servicio) y un comentario. Una por pedido.
-- * Queja: el cliente marca los productos con problema, escribe el motivo y
--   sube hasta 4 fotos. Una por pedido. El administrador la aprueba (con
--   empleado responsable, compensacion al monedero o en puntos y descuento
--   en nomina, todo opcional) o la rechaza con motivo. El cliente ve el
--   resultado en su seguimiento y le llega por correo.

CREATE TABLE order_ratings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL,
  branch_id       uuid NOT NULL,
  customer_id     uuid,
  overall         smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
  food            smallint CHECK (food BETWEEN 1 AND 5),
  service         smallint CHECK (service BETWEEN 1 AND 5),
  comment         text CHECK (length(comment) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, order_id),
  FOREIGN KEY (restaurant_id, order_id)    REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)   REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id)
);
CREATE INDEX order_ratings_branch_idx ON order_ratings (restaurant_id, branch_id, created_at DESC);

CREATE TABLE customer_complaints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id              uuid NOT NULL,
  branch_id             uuid NOT NULL,
  customer_id           uuid,
  contact_name          text,
  contact_phone         text,
  contact_email         text,
  reason                text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  -- Productos con problema: [{order_item_id, name, quantity}] (copia al momento).
  items                 jsonb NOT NULL DEFAULT '[]',
  evidence_urls         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_urls) <= 4),
  status                text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobada', 'rechazada')),
  -- Revision del administrador.
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_notes          text CHECK (length(review_notes) <= 1000),
  responsible_employee_id uuid,
  compensation_type     text NOT NULL DEFAULT 'ninguna' CHECK (compensation_type IN ('ninguna', 'monedero', 'puntos')),
  compensation_amount   numeric(10,2) CHECK (compensation_amount IS NULL OR compensation_amount > 0),
  compensation_points   integer CHECK (compensation_points IS NULL OR compensation_points > 0),
  employee_charge       numeric(10,2) CHECK (employee_charge IS NULL OR employee_charge > 0),
  payroll_adjustment_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, order_id),
  CHECK (status = 'pendiente' OR reviewed_at IS NOT NULL),
  CHECK (status = 'aprobada' OR (compensation_type = 'ninguna' AND employee_charge IS NULL)),
  CHECK (employee_charge IS NULL OR responsible_employee_id IS NOT NULL),
  FOREIGN KEY (restaurant_id, order_id)    REFERENCES orders (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id)   REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, customer_id) REFERENCES customers (restaurant_id, id),
  FOREIGN KEY (restaurant_id, reviewed_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, responsible_employee_id) REFERENCES employees (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restaurant_id, payroll_adjustment_id) REFERENCES payroll_adjustments (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX customer_complaints_status_idx ON customer_complaints (restaurant_id, status, created_at DESC);

-- El descuento en nomina por una queja queda marcado con su origen.
ALTER TABLE payroll_adjustments DROP CONSTRAINT payroll_adjustments_source_check;
ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_source_check
  CHECK (source IN ('manual', 'empleado_mes', 'queja'));

-- Aviso push al personal de una queja nueva.
ALTER TABLE push_outbox DROP CONSTRAINT push_outbox_kind_check;
ALTER TABLE push_outbox ADD CONSTRAINT push_outbox_kind_check
  CHECK (kind IN ('aceptado', 'listo', 'en_camino', 'rechazado', 'cancelado', 'nuevo_pedido', 'asignado', 'queja'));

CREATE OR REPLACE FUNCTION complaints_push_events() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM push_enqueue(NEW.restaurant_id, 'queja', NEW.order_id);
  RETURN NULL;
END
$$;

CREATE TRIGGER complaints_push_events
  AFTER INSERT ON customer_complaints
  FOR EACH ROW EXECUTE FUNCTION complaints_push_events();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_ratings', 'customer_complaints'] LOOP
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
  ('quejas', 'Calificaciones y quejas',
   'El cliente califica su pedido con estrellas y reporta problemas con fotos; el restaurante ve el promedio por sucursal y resuelve cada queja con compensación al monedero o en puntos y descuento al responsable.', 80, 34)
ON CONFLICT (code) DO NOTHING;
