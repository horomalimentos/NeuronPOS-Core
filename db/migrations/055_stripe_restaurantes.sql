-- Stripe tambien para cada restaurante: los pedidos en linea de su portal y
-- las recargas del monedero se pueden cobrar con su propia cuenta de Stripe
-- (si la configura, se usa en vez de Clip). Llaves cifradas como las de Clip.
ALTER TABLE clip_checkouts DROP CONSTRAINT IF EXISTS clip_checkouts_stripe_suscripcion;

ALTER TABLE restaurant_payment_settings
  ADD COLUMN stripe_secret_key_enc     text,
  ADD COLUMN stripe_webhook_secret_enc text;
