-- 014: Correos y recuperar contrasena.
--
-- * Clientes del portal y personal del restaurante pueden pedir una liga
--   para cambiar su contrasena. Solo se guarda el hash (sha256) del token,
--   vence en 1 hora, sirve una vez y pedir otra invalida la anterior.
-- * password_changed_at: al cambiar la contrasena se cierran las sesiones
--   abiertas (los tokens emitidos antes ya no sirven).
-- * online_settings.order_email_alerts: aviso por correo a los
--   administradores de cada pedido en linea nuevo.

ALTER TABLE customers
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN reset_token_hash    bytea,
  ADD COLUMN reset_expires_at    timestamptz;

ALTER TABLE users
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN reset_token_hash    bytea,
  ADD COLUMN reset_expires_at    timestamptz;

CREATE INDEX customers_reset_idx ON customers (reset_token_hash) WHERE reset_token_hash IS NOT NULL;
CREATE INDEX users_reset_idx ON users (reset_token_hash) WHERE reset_token_hash IS NOT NULL;

ALTER TABLE online_settings ADD COLUMN order_email_alerts boolean NOT NULL DEFAULT false;
