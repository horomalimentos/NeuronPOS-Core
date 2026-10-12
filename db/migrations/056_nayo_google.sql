-- Nayo: entrar con Google. La cuenta guarda el "sub" de Google (id estable de
-- la persona) y puede no tener contrasena ni telefono: el telefono se pide al
-- hacer el primer pedido y se guarda en la cuenta.
ALTER TABLE nayo_customers
  ADD COLUMN google_sub text UNIQUE,
  ALTER COLUMN password_hash DROP NOT NULL,
  ALTER COLUMN phone DROP NOT NULL;

-- Verificar el correo: al crear cuenta con correo se manda un codigo de 6
-- digitos y no se puede pedir hasta escribirlo. Google ya verifica el correo.
-- Las cuentas que ya existian quedan verificadas.
ALTER TABLE nayo_customers
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN verify_code_hash bytea,
  ADD COLUMN verify_expires_at timestamptz,
  ADD COLUMN verify_attempts int NOT NULL DEFAULT 0;
UPDATE nayo_customers SET email_verified_at = created_at;
