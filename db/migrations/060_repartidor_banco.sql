-- Nayo: datos bancarios del repartidor para depositarle su saldo a favor
-- (pedidos con tarjeta). Los captura el repartidor en su app; el Panel los
-- ve en Cuentas de repartidores al registrar una liquidacion.
ALTER TABLE fleet_drivers
  ADD COLUMN bank_name text CHECK (length(bank_name) BETWEEN 2 AND 80),
  ADD COLUMN bank_clabe text CHECK (bank_clabe ~ '^[0-9]{18}$'),
  ADD COLUMN bank_holder text CHECK (length(bank_holder) BETWEEN 3 AND 120),
  ADD COLUMN bank_updated_at timestamptz;
