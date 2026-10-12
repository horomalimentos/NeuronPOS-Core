-- 015: Cobro con la terminal fisica de Clip (API de PinPad), como en Horom.
--
-- Cada caja (sucursal + nombre de terminal) puede tener el numero de serie de
-- su terminal Clip. La caja pide el cobro, la terminal se enciende con el
-- monto y el resultado SIEMPRE se consulta a Clip server-to-server (el webhook
-- solo trae el id). Un cobro aprobado se usa una sola vez como pago con
-- tarjeta de su orden (used_payment_id). Modulo con precio aparte.

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('terminal_clip', 'Terminal Clip en caja', 'Cobro con la terminal fisica de Clip desde el punto de venta.', 0, 16)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE pos_clip_terminals (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL,
  terminal      text NOT NULL,
  serial_number text NOT NULL CHECK (serial_number ~ '^[A-Z0-9-]{6,40}$'),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, terminal),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX pos_clip_terminals_restaurant_idx ON pos_clip_terminals (restaurant_id);

CREATE TABLE clip_pinpad_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL,
  branch_id         uuid NOT NULL,
  terminal          text NOT NULL,
  serial_number     text NOT NULL,
  reference         text NOT NULL UNIQUE,
  amount            numeric(10,2) NOT NULL CHECK (amount > 0),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  pinpad_request_id text UNIQUE,
  amount_paid       numeric(10,2),
  transaction_id    text,
  card_last_digits  text,
  card_brand        text,
  error_message     text,
  clip_response     jsonb,
  used_payment_id   uuid,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX clip_pinpad_requests_order_idx ON clip_pinpad_requests (restaurant_id, order_id);
CREATE INDEX clip_pinpad_requests_pending_idx ON clip_pinpad_requests (serial_number) WHERE status = 'PENDING';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_clip_terminals', 'clip_pinpad_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))',
      t
    );
  END LOOP;
END
$$;
