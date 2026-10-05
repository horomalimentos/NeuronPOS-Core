-- 006: Cobro con Clip (Fase 3).
--
-- A) Suscripcion de la plataforma: NeuronPOS cobra a cada restaurante su
--    mensualidad con la cuenta de Clip de la plataforma.
--    - platform_settings: dias de gracia antes de suspender.
--    - restaurants: dia de cobro, fecha de alta y motivo de suspension (solo
--      las suspensiones por falta de pago se reactivan solas al pagar).
--    - subscription_invoices: periodo con inicio y fin (el dia de cobro ya no
--      es siempre el 1), fecha limite, desglose y como se pago.
--    - subscription_invoice_items: una linea por modulo cobrado.
-- B) Pagos en linea de los pedidos del portal: el dinero va a la cuenta de
--    Clip de CADA restaurante.
--    - restaurant_payment_settings: credenciales de Clip del restaurante
--      CIFRADAS (AES-256-GCM, la llave vive en PAYMENT_SECRETS_KEY y nunca en
--      la BD) e interruptor de "pago en linea".
--    - orders: estado del pago en linea y hora limite para pagar.
--    - order_payments: un pago en linea no tiene turno de caja ni usuario;
--      apunta al checkout de Clip que lo origino.
--    - payment_methods: tipo 'en_linea' ("Clip en linea"), sembrado por
--      restaurante; no se usa en la caja.
-- Comun:
--    - clip_checkouts: cada liga de pago creada en Clip, de una factura de
--      suscripcion o de un pedido. La concilian el webhook y el job.
--    - clip_webhook_events: bitacora de webhooks recibidos.
--
-- Mismas reglas que 004/005: restaurant_id + llaves compuestas + RLS (FORCE).

-- ---------------------------------------------------------------------------
-- Plataforma
-- ---------------------------------------------------------------------------

-- Una sola fila (id = true).
CREATE TABLE platform_settings (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Dias despues de la fecha limite antes de suspender por falta de pago.
  grace_days integer NOT NULL DEFAULT 5 CHECK (grace_days BETWEEN 0 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings DEFAULT VALUES;

ALTER TABLE restaurants
  -- Dia del mes en que se cobra (NULL = el dia en que se activo). En meses
  -- mas cortos se cobra el ultimo dia.
  ADD COLUMN billing_day         smallint CHECK (billing_day BETWEEN 1 AND 31),
  -- Cuando paso a 'active' (al terminar la prueba o al activarlo el dueno).
  ADD COLUMN activated_at        timestamptz,
  -- falta_pago = la suspendio el cobro automatico (se reactiva sola al pagar);
  -- manual = la suspendio el dueno de la plataforma.
  ADD COLUMN suspended_reason    text CHECK (suspended_reason IN ('falta_pago', 'manual')),
  -- Si el dueno reactiva a mano un restaurante con adeudo, el cobro
  -- automatico no lo vuelve a suspender antes de esta fecha.
  ADD COLUMN dunning_grace_until date;

UPDATE restaurants SET activated_at = created_at WHERE status = 'active';
UPDATE restaurants SET suspended_reason = 'manual' WHERE status = 'suspended';

-- ---------------------------------------------------------------------------
-- Facturas de suscripcion
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_invoices DROP CONSTRAINT IF EXISTS subscription_invoices_period_check;
ALTER TABLE subscription_invoices DROP CONSTRAINT IF EXISTS subscription_invoices_status_check;

ALTER TABLE subscription_invoices
  -- period = primer dia del periodo; period_end = ultimo dia (incluido).
  ADD COLUMN period_end     date,
  -- Fecha limite de pago (el dia de cobro). Suspende: due_date + gracia.
  ADD COLUMN due_date       date,
  ADD COLUMN subtotal_mxn   numeric(10,2) NOT NULL DEFAULT 0 CHECK (subtotal_mxn >= 0),
  ADD COLUMN discount_mxn   numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount_mxn >= 0),
  ADD COLUMN currency       text NOT NULL DEFAULT 'MXN',
  -- clip = liga de pago; manual = el dueno lo marco (transferencia...);
  -- sin_cargo = total en 0.
  ADD COLUMN paid_method    text CHECK (paid_method IN ('clip', 'manual', 'sin_cargo')),
  ADD COLUMN paid_reference text,
  ADD COLUMN paid_note      text,
  ADD COLUMN paid_by        uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  ADD COLUMN overdue_at     timestamptz,
  -- Ultima vez que se mando (o reenvio) la liga al restaurante.
  ADD COLUMN last_sent_at   timestamptz,
  ADD CONSTRAINT subscription_invoices_status_check CHECK (status IN ('pending', 'paid', 'overdue', 'void')),
  ADD CONSTRAINT subscription_invoices_paid_check CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND paid_method IS NOT NULL)),
  ADD CONSTRAINT subscription_invoices_restaurant_id_id_key UNIQUE (restaurant_id, id);

UPDATE subscription_invoices
   SET period_end = (period + interval '1 month' - interval '1 day')::date, due_date = period
 WHERE period_end IS NULL;
ALTER TABLE subscription_invoices
  ALTER COLUMN period_end SET NOT NULL,
  ALTER COLUMN due_date SET NOT NULL,
  ADD CONSTRAINT subscription_invoices_period_range CHECK (period_end >= period);
CREATE INDEX subscription_invoices_status_idx ON subscription_invoices (status, due_date);

-- Desglose: precio del modulo (especial o de catalogo), descuento e importe.
CREATE TABLE subscription_invoice_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  module_code       text NOT NULL,
  name              text NOT NULL,
  catalog_price_mxn numeric(10,2) NOT NULL,
  custom_price_mxn  numeric(10,2),
  -- Precio usado: el especial si existe, si no el de catalogo.
  unit_price_mxn    numeric(10,2) NOT NULL CHECK (unit_price_mxn >= 0),
  discount_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  discount_mxn      numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount_mxn >= 0),
  amount_mxn        numeric(10,2) NOT NULL CHECK (amount_mxn >= 0),
  sort_order        integer NOT NULL DEFAULT 0,
  UNIQUE (invoice_id, module_code),
  CHECK (amount_mxn = unit_price_mxn - discount_mxn),
  FOREIGN KEY (restaurant_id, invoice_id) REFERENCES subscription_invoices (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX subscription_invoice_items_restaurant_idx ON subscription_invoice_items (restaurant_id, invoice_id);

-- ---------------------------------------------------------------------------
-- Pagos en linea de pedidos
-- ---------------------------------------------------------------------------

CREATE TABLE restaurant_payment_settings (
  restaurant_id           uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Formato v1:<iv>:<tag>:<cifrado> (base64). Nunca se regresan por la API.
  clip_api_key_enc        text,
  clip_secret_key_enc     text,
  clip_webhook_secret_enc text,
  -- El cliente puede elegir "Pagar en linea con Clip" en el checkout.
  online_payment_enabled  boolean NOT NULL DEFAULT false,
  -- Minutos para pagar antes de que el pedido se cancele solo.
  payment_timeout_minutes integer NOT NULL DEFAULT 30 CHECK (payment_timeout_minutes BETWEEN 5 AND 1440),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((clip_api_key_enc IS NULL) = (clip_secret_key_enc IS NULL))
);

ALTER TABLE orders
  -- NULL = pago al recibir. pendiente = esperando el pago en linea (el pedido
  -- no llega al POS); pagado; cancelado = no se pago a tiempo.
  ADD COLUMN online_payment_status text CHECK (online_payment_status IN ('pendiente', 'pagado', 'cancelado')),
  ADD COLUMN payment_due_at        timestamptz,
  ADD CONSTRAINT orders_online_payment_web CHECK (online_payment_status IS NULL OR source = 'web');
CREATE INDEX orders_online_payment_idx ON orders (payment_due_at) WHERE online_payment_status = 'pendiente';

ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
  CHECK (kind IN ('efectivo', 'tarjeta', 'transferencia', 'otro', 'en_linea'));

-- ---------------------------------------------------------------------------
-- Ligas de pago de Clip
-- ---------------------------------------------------------------------------

CREATE TABLE clip_checkouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- suscripcion = cuenta de Clip de la plataforma; pedido = cuenta del restaurante.
  purpose       text NOT NULL CHECK (purpose IN ('suscripcion', 'pedido')),
  invoice_id    uuid,
  order_id      uuid,
  -- payment_request_id de Clip.
  checkout_id   text NOT NULL UNIQUE,
  payment_url   text NOT NULL,
  amount        numeric(10,2) NOT NULL CHECK (amount > 0),
  currency      text NOT NULL DEFAULT 'MXN',
  -- Estado normalizado: pending, completed, cancelled, expired, failed.
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'cancelled', 'expired', 'failed')),
  expires_at    timestamptz,
  -- Cuando el pago se aplico a la factura o al pedido (idempotencia).
  applied_at    timestamptz,
  -- Pago confirmado despues de cancelar el pedido: hay que reembolsarlo en Clip.
  late_payment  boolean NOT NULL DEFAULT false,
  clip_reference text,
  response_data jsonb,
  last_checked_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  CHECK ((purpose = 'suscripcion') = (invoice_id IS NOT NULL)),
  CHECK ((purpose = 'pedido') = (order_id IS NOT NULL)),
  FOREIGN KEY (restaurant_id, invoice_id) REFERENCES subscription_invoices (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, order_id)   REFERENCES orders (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX clip_checkouts_pending_idx ON clip_checkouts (created_at) WHERE status = 'pending';
CREATE INDEX clip_checkouts_invoice_idx ON clip_checkouts (restaurant_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX clip_checkouts_order_idx ON clip_checkouts (restaurant_id, order_id) WHERE order_id IS NOT NULL;
-- Una sola liga vigente por factura o pedido.
CREATE UNIQUE INDEX clip_checkouts_one_pending_invoice ON clip_checkouts (invoice_id) WHERE status = 'pending' AND invoice_id IS NOT NULL;
CREATE UNIQUE INDEX clip_checkouts_one_pending_order ON clip_checkouts (order_id) WHERE status = 'pending' AND order_id IS NOT NULL;

-- Pagos en linea: sin turno de caja ni usuario, ligados a su checkout.
ALTER TABLE order_payments
  ALTER COLUMN cash_session_id DROP NOT NULL,
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN clip_checkout_id uuid,
  ADD CONSTRAINT order_payments_clip_checkout_fk FOREIGN KEY (restaurant_id, clip_checkout_id)
    REFERENCES clip_checkouts (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT order_payments_origin CHECK (
    clip_checkout_id IS NOT NULL OR (cash_session_id IS NOT NULL AND created_by IS NOT NULL)
  );
-- Un checkout se aplica una sola vez.
CREATE UNIQUE INDEX order_payments_one_per_checkout ON order_payments (clip_checkout_id) WHERE clip_checkout_id IS NOT NULL;

-- Bitacora de webhooks. restaurant_id NULL = webhook de la plataforma
-- (solo visible en contexto de plataforma).
CREATE TABLE clip_webhook_events (
  id              bigserial PRIMARY KEY,
  restaurant_id   uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  checkout_id     text,
  event_type      text,
  signature_valid boolean,
  matched         boolean NOT NULL DEFAULT false,
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clip_webhook_events_checkout_idx ON clip_webhook_events (checkout_id);

-- ---------------------------------------------------------------------------
-- Metodo de pago "Clip en linea" por restaurante
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seed_pos_defaults(rid uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pos_settings (restaurant_id) VALUES (rid) ON CONFLICT DO NOTHING;
  INSERT INTO payment_methods (restaurant_id, name, kind, sort_order) VALUES
    (rid, 'Efectivo', 'efectivo', 10),
    (rid, 'Tarjeta', 'tarjeta', 20),
    (rid, 'Transferencia', 'transferencia', 30)
  ON CONFLICT (restaurant_id, name) DO NOTHING;
  INSERT INTO payment_methods (restaurant_id, name, kind, sort_order)
  SELECT rid, 'Clip en línea', 'en_linea', 90
   WHERE NOT EXISTS (SELECT 1 FROM payment_methods WHERE restaurant_id = rid AND kind = 'en_linea')
  ON CONFLICT (restaurant_id, name) DO NOTHING;
$$;

-- ---------------------------------------------------------------------------
-- RLS (misma politica que 003). clip_webhook_events usa la misma funcion:
-- las filas con restaurant_id NULL solo las ve la plataforma.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscription_invoice_items', 'restaurant_payment_settings', 'clip_checkouts', 'clip_webhook_events'
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

SELECT set_config('app.is_platform', 'on', true);
SELECT seed_pos_defaults(id) FROM restaurants;
