-- 034: Categoria de las entradas y salidas de efectivo (compras, propinas,
-- nomina, retiro...), para ver en el corte y en reportes en que se va el efectivo.

ALTER TABLE cash_movements ADD COLUMN category text NOT NULL DEFAULT 'otro'
  CHECK (category IN ('compras', 'servicios', 'propinas', 'nomina', 'retiro', 'fondo', 'otro'));
