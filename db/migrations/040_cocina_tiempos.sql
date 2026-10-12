-- 028: Tiempos de la pantalla de cocina configurables por restaurante
-- (antes fijos: amarillo a los 10 min y rojo a los 20).

ALTER TABLE pos_settings
  ADD COLUMN kitchen_warn_minutes integer NOT NULL DEFAULT 10 CHECK (kitchen_warn_minutes BETWEEN 1 AND 240),
  ADD COLUMN kitchen_late_minutes integer NOT NULL DEFAULT 20 CHECK (kitchen_late_minutes BETWEEN 1 AND 480),
  ADD CONSTRAINT pos_settings_kitchen_times CHECK (kitchen_late_minutes > kitchen_warn_minutes);
