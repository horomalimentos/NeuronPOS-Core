-- Nayo: el repartidor paga la comida en el restaurante al recoger el pedido.
-- Ese pago queda registrado en la orden del restaurante (ligado al pedido de
-- Nayo) y entra al turno de caja abierto de la sucursal, si hay uno.
ALTER TABLE order_payments ADD COLUMN marketplace_order_id uuid;
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_origin;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_origin CHECK (
  clip_checkout_id IS NOT NULL
  OR delivery_request_id IS NOT NULL
  OR wallet_customer_id IS NOT NULL
  OR marketplace_order_id IS NOT NULL
  OR (created_by IS NOT NULL AND (cash_session_id IS NOT NULL OR driver_user_id IS NOT NULL))
);
