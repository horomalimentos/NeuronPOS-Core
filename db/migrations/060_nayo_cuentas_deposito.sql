-- Nayo: cuenta bancaria para depositos de cada repartidor de la flota y de
-- cada restaurante (CLABE de 18 digitos). La capturan ellos en su app y el
-- Panel la ve para hacer las transferencias. Solo la plataforma lee y
-- escribe (el backend entra como plataforma); los duenos la ven enmascarada.
CREATE TABLE nayo_payout_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     uuid UNIQUE REFERENCES fleet_drivers(id) ON DELETE CASCADE,
  restaurant_id uuid UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  holder_name   text NOT NULL CHECK (length(holder_name) BETWEEN 2 AND 120),
  bank          text NOT NULL CHECK (length(bank) BETWEEN 2 AND 60),
  clabe         text NOT NULL CHECK (clabe ~ '^[0-9]{18}$'),
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(driver_id, restaurant_id) = 1)
);

ALTER TABLE nayo_payout_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nayo_payout_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON nayo_payout_accounts USING (app_is_platform()) WITH CHECK (app_is_platform());
