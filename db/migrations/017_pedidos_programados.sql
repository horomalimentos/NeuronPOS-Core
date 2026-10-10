-- 017: Pedidos programados (modulo 'pedidos_programados'), adaptado de
-- Horom (jobs/scheduledOrderDispatcher.js).
--
-- El cliente elige "para mas tarde" (hasta N dias, en horario de la
-- sucursal y con anticipacion minima). El restaurante lo acepta cuando
-- quiera, pero llega a cocina sola X minutos antes de la hora (job cada
-- minuto). Mientras tanto el cliente lo ve como "Programado".

ALTER TABLE online_settings
  ADD COLUMN schedule_max_days         integer NOT NULL DEFAULT 3 CHECK (schedule_max_days BETWEEN 0 AND 14),
  ADD COLUMN schedule_min_lead_minutes integer NOT NULL DEFAULT 60 CHECK (schedule_min_lead_minutes BETWEEN 15 AND 1440),
  ADD COLUMN schedule_kitchen_minutes  integer NOT NULL DEFAULT 45 CHECK (schedule_kitchen_minutes BETWEEN 5 AND 600);

ALTER TABLE orders ADD COLUMN scheduled_for timestamptz;
CREATE INDEX orders_scheduled_idx ON orders (scheduled_for)
  WHERE scheduled_for IS NOT NULL AND sent_at IS NULL AND status = 'abierta';

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('pedidos_programados', 'Pedidos programados',
   'El cliente pide en línea para más tarde (hoy o los próximos días, en tu horario); el pedido entra a cocina solo, antes de la hora.', 60, 33)
ON CONFLICT (code) DO NOTHING;
