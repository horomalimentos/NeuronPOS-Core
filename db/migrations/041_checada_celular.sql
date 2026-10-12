-- 030: Checada desde el celular del empleado (como en Horom). Por sucursal se
-- permite checar con la sesion del empleado en su telefono, siempre dentro de
-- la geocerca (la ubicacion es obligatoria; la lista de IPs no aplica porque
-- el celular usa datos moviles).

ALTER TABLE hr_clock_settings ADD COLUMN mobile_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE hr_clock_settings ADD CONSTRAINT hr_clock_settings_mobile_geo CHECK (NOT mobile_enabled OR geo_enabled);

ALTER TABLE time_entries DROP CONSTRAINT time_entries_source_check;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_check CHECK (source IN ('kiosco', 'manual', 'importado', 'celular'));
