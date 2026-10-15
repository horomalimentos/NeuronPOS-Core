-- Nayo repartidor: "olvide mi contrasena". En la base solo queda el sha256 del
-- token; el token va en el correo, vence en 1 hora y sirve una vez. Al cambiar
-- la contrasena se marca password_changed_at y las sesiones viejas dejan de servir.
ALTER TABLE fleet_drivers
  ADD COLUMN reset_token_hash bytea,
  ADD COLUMN reset_expires_at timestamptz,
  ADD COLUMN password_changed_at timestamptz;
CREATE INDEX fleet_drivers_reset_idx ON fleet_drivers (reset_token_hash) WHERE reset_token_hash IS NOT NULL;
