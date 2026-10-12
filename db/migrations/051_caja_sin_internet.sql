-- 050: Caja sin internet (como el modo offline de la caja de Horom), modulo
-- "sin_internet".
--
-- Si se cae el internet, la caja sigue vendiendo con el menu que guardo en el
-- equipo: cobra, imprime ticket y comanda en la impresora local y guarda la
-- venta en el equipo. Al volver el internet la sube a POST
-- /api/pos/offline-orders, que crea la orden ya pagada con los precios con
-- los que se cobro. offline_id (lo genera el equipo) evita subirla dos veces.

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('sin_internet', 'Caja sin internet', 'La caja sigue vendiendo y cobrando aunque se caiga el internet; las ventas se suben solas al volver.', 0, 24)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE orders ADD COLUMN offline_id uuid;
CREATE UNIQUE INDEX orders_offline_id_key ON orders (restaurant_id, offline_id) WHERE offline_id IS NOT NULL;
