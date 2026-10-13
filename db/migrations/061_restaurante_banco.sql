-- Nayo: datos bancarios del restaurante para depositarle lo de sus pedidos
-- (igual que los del repartidor en 060). Los captura el dueno o gerente en
-- Nayo; el Panel los ve en Panel › Nayo › Restaurantes.
ALTER TABLE restaurants
  ADD COLUMN bank_name text CHECK (length(bank_name) BETWEEN 2 AND 80),
  ADD COLUMN bank_clabe text CHECK (bank_clabe ~ '^[0-9]{18}$'),
  ADD COLUMN bank_holder text CHECK (length(bank_holder) BETWEEN 3 AND 120),
  ADD COLUMN bank_updated_at timestamptz;
