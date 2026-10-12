-- NeuronPOS Delivery: un repartidor puede llevar varios pedidos a la vez
-- (empieza en 2, como en la version del servidor). Se cambia en el Panel.
ALTER TABLE marketplace_settings
  ADD COLUMN driver_max_orders smallint NOT NULL DEFAULT 2 CHECK (driver_max_orders BETWEEN 1 AND 5);
