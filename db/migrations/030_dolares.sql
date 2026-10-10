-- 013: Cobro en dolares y conteo por denominaciones (como en Horom).
--
-- Un metodo de pago en efectivo puede ser en USD. Cada turno de caja tiene su
-- tipo de cambio (por omision el de la configuracion). Al cobrar en dolares se
-- guarda lo recibido en USD y el tipo de cambio; lo que se abona a la cuenta y
-- el cambio son en pesos (el cambio sale del cajon de pesos). En el corte los
-- dolares se esperan y se cuentan en dolares. count_detail guarda el conteo de
-- billetes y monedas del cierre.

ALTER TABLE payment_methods ADD COLUMN currency text NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN', 'USD'));
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_usd_cash CHECK (currency = 'MXN' OR kind = 'efectivo');

ALTER TABLE pos_settings ADD COLUMN usd_rate numeric(10,4) NOT NULL DEFAULT 17 CHECK (usd_rate > 0 AND usd_rate < 1000);

ALTER TABLE cash_sessions
  ADD COLUMN usd_rate     numeric(10,4) CHECK (usd_rate IS NULL OR (usd_rate > 0 AND usd_rate < 1000)),
  ADD COLUMN count_detail jsonb;

ALTER TABLE order_payments
  ADD COLUMN currency         text NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN', 'USD')),
  ADD COLUMN foreign_received numeric(10,2) CHECK (foreign_received IS NULL OR foreign_received > 0),
  ADD COLUMN exchange_rate    numeric(10,4),
  ADD CONSTRAINT order_payments_usd CHECK (currency = 'MXN' OR (foreign_received IS NOT NULL AND exchange_rate > 0));
