-- 019: Kiosko de autoservicio (como el kiosko de Horom), modulo "kiosko".
--
-- Una tablet en el local con la pantalla /kiosko (sesion de un usuario de
-- caja). El cliente arma su orden, elige comer aqui o para llevar y da su
-- nombre; la orden queda abierta con source = 'kiosko' y su folio, y se paga en
-- caja (al cobrar se manda a cocina, como cualquier orden).

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('kiosko', 'Kiosko de autoservicio', 'Pantalla para que el cliente ordene solo y pague en caja.', 0, 19)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('pos', 'web', 'kiosko'));
-- Comer aqui en el kiosko no lleva mesa: se guarda como para llevar con esta marca.
ALTER TABLE orders ADD COLUMN dine_in boolean NOT NULL DEFAULT false;
