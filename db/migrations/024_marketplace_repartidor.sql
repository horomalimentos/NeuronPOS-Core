-- NeuronPOS Delivery (fase 3: el repartidor y el dinero).
--
-- Flujo de dinero (decidido por Alex):
--   - Efectivo: el repartidor cobra al cliente comida + envio, paga la comida
--     en el restaurante y se queda el envio. La parte de NeuronPOS del envio
--     (20 %) queda como adeudo: movimiento 'comision_efectivo' negativo.
--   - Tarjeta (Clip de NeuronPOS): el cliente paga todo en linea. El
--     repartidor tambien paga la comida en el restaurante al recoger, y al
--     entregar NeuronPOS le abona la comida + su parte del envio:
--     movimiento 'abono_tarjeta' positivo, que primero cubre su adeudo.
--   - Saldo = suma de movimientos. Negativo = debe a NeuronPOS; con adeudo
--     igual o mayor al tope ya no toma pedidos en efectivo. Puede pagar con
--     tarjeta ('pago_clip') o en efectivo al Panel ('pago_efectivo'); un
--     saldo a favor se le liquida ('liquidacion', negativo).
--
--   - marketplace_orders: 'pago_pendiente' (tarjeta sin pagar aun), paid_at.
--     La orden del restaurante ya no lleva el envio (no es suyo).
--   - marketplace_driver_ledger: movimientos del repartidor.
--   - marketplace_checkouts: ligas de Clip de la plataforma para pedidos con
--     tarjeta y pagos de adeudo.

ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_status_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_status_check
  CHECK (status IN ('pago_pendiente', 'nuevo', 'aceptado', 'listo', 'en_camino', 'entregado', 'rechazado', 'cancelado'));
ALTER TABLE marketplace_orders
  ADD COLUMN paid_at     timestamptz,
  ADD COLUMN assigned_at timestamptz;
CREATE INDEX marketplace_orders_driver_idx ON marketplace_orders (driver_id, status) WHERE driver_id IS NOT NULL;

CREATE TABLE marketplace_driver_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id            uuid NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  marketplace_order_id uuid REFERENCES marketplace_orders(id) ON DELETE SET NULL,
  kind                 text NOT NULL CHECK (kind IN ('comision_efectivo', 'abono_tarjeta', 'pago_clip', 'pago_efectivo', 'liquidacion', 'ajuste')),
  -- Positivo: a favor del repartidor. Negativo: lo debe a NeuronPOS.
  amount               numeric(10,2) NOT NULL CHECK (amount <> 0),
  note                 text,
  checkout_id          uuid,
  created_by           uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'comision_efectivo' OR amount < 0),
  CHECK (kind NOT IN ('abono_tarjeta', 'pago_clip', 'pago_efectivo') OR amount > 0),
  CHECK (kind <> 'liquidacion' OR amount < 0)
);
CREATE INDEX marketplace_driver_ledger_driver_idx ON marketplace_driver_ledger (driver_id, created_at DESC);
-- Un movimiento automatico por pedido y tipo; un pago de Clip una vez.
CREATE UNIQUE INDEX marketplace_driver_ledger_order_once ON marketplace_driver_ledger (marketplace_order_id, kind)
  WHERE marketplace_order_id IS NOT NULL;
CREATE UNIQUE INDEX marketplace_driver_ledger_checkout_once ON marketplace_driver_ledger (checkout_id)
  WHERE checkout_id IS NOT NULL;

CREATE TABLE marketplace_checkouts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose              text NOT NULL CHECK (purpose IN ('pedido', 'adeudo')),
  marketplace_order_id uuid REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  driver_id            uuid REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  checkout_id          text NOT NULL UNIQUE,
  payment_url          text NOT NULL,
  amount               numeric(10,2) NOT NULL CHECK (amount > 0),
  currency             text NOT NULL DEFAULT 'MXN',
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'expired', 'failed')),
  expires_at           timestamptz,
  applied_at           timestamptz,
  late_payment         boolean NOT NULL DEFAULT false,
  clip_reference       text,
  response_data        jsonb,
  last_checked_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'pedido') = (marketplace_order_id IS NOT NULL)),
  CHECK ((purpose = 'adeudo') = (driver_id IS NOT NULL))
);
CREATE INDEX marketplace_checkouts_pending_idx ON marketplace_checkouts (created_at) WHERE status = 'pending';
CREATE INDEX marketplace_checkouts_order_idx ON marketplace_checkouts (marketplace_order_id);

ALTER TABLE marketplace_driver_ledger ADD CONSTRAINT marketplace_driver_ledger_checkout_fk
  FOREIGN KEY (checkout_id) REFERENCES marketplace_checkouts(id) ON DELETE SET NULL;

-- El Panel todo; el repartidor solo lee sus movimientos y sus ligas.
ALTER TABLE marketplace_driver_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_driver_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON marketplace_driver_ledger USING (app_is_platform()) WITH CHECK (app_is_platform());
CREATE POLICY driver_read ON marketplace_driver_ledger FOR SELECT USING (driver_id = app_current_fleet_driver_id());

ALTER TABLE marketplace_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_checkouts FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON marketplace_checkouts USING (app_is_platform()) WITH CHECK (app_is_platform());
CREATE POLICY driver_read ON marketplace_checkouts FOR SELECT USING (driver_id = app_current_fleet_driver_id());

-- El restaurante ve sus pedidos de Delivery solo cuando ya estan pagados (o son en efectivo).
DROP POLICY IF EXISTS marketplace_order_access ON marketplace_orders;
CREATE POLICY marketplace_order_access ON marketplace_orders
  USING (app_is_platform()
         OR (app_can_access(restaurant_id) AND status <> 'pago_pendiente')
         OR (driver_id IS NOT NULL AND driver_id = app_current_fleet_driver_id()))
  WITH CHECK (app_can_access(restaurant_id) OR (driver_id IS NOT NULL AND driver_id = app_current_fleet_driver_id()));
