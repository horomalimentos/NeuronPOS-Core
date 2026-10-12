-- Stripe como alternativa a Clip para los cobros de la cuenta de la
-- plataforma (mensualidades y Nayo). Cada liga recuerda con que proveedor se
-- creo, para conciliarla con el mismo aunque despues se cambie de proveedor.
-- Los pagos en linea de cada restaurante siguen siendo con su cuenta de Clip.
ALTER TABLE clip_checkouts
  ADD COLUMN provider text NOT NULL DEFAULT 'clip' CHECK (provider IN ('clip', 'stripe')),
  ADD CONSTRAINT clip_checkouts_stripe_suscripcion CHECK (provider = 'clip' OR purpose = 'suscripcion');

ALTER TABLE marketplace_checkouts
  ADD COLUMN provider text NOT NULL DEFAULT 'clip' CHECK (provider IN ('clip', 'stripe'));

-- Una factura pagada con una liga de Stripe.
ALTER TABLE subscription_invoices DROP CONSTRAINT IF EXISTS subscription_invoices_paid_method_check;
ALTER TABLE subscription_invoices ADD CONSTRAINT subscription_invoices_paid_method_check
  CHECK (paid_method IN ('clip', 'stripe', 'manual', 'sin_cargo'));
