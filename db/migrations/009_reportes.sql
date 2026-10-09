-- 009: Reportes de ventas (GET /api/pos/reports/sales).
-- Los reportes filtran las ordenes pagadas por fecha de pago.
CREATE INDEX IF NOT EXISTS orders_paid_at_idx ON orders (restaurant_id, paid_at) WHERE status = 'pagada';
