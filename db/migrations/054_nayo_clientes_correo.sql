-- Nayo: "olvide mi contrasena" para las cuentas de clientes. En la base solo
-- queda el sha256 del token; el token va en el correo y sirve una vez.
ALTER TABLE nayo_customers
  ADD COLUMN reset_token_hash bytea,
  ADD COLUMN reset_expires_at timestamptz;
