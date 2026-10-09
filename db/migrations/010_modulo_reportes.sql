-- 010: Los reportes de ventas son un modulo aparte ('reportes'), con su
-- precio mensual editable en el Panel. Requiere tambien el modulo 'pos'
-- (los reportes salen de sus ventas).
INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('reportes', 'Reportes de ventas',
   'Ventas por día, hora, producto, categoría, método de pago y persona, con comparativos y descarga a Excel.', 150, 15)
ON CONFLICT (code) DO NOTHING;
