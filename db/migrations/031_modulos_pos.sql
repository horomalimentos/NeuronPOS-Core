-- 014: Las funciones nuevas del POS se venden como modulos (se suman a la
-- mensualidad). Precio 0 como marcador: el dueno lo fija en el Panel.
INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('estaciones',  'Estaciones de cocina',   'Barra, parrilla, sushi...: cada estacion con su pantalla y su impresora de comandas.', 0, 11),
  ('reportes',    'Reportes de ventas',     'Ventas por dia, hora, articulo, categoria, pago y usuario, tiempos de cocina y tickets.', 0, 12),
  ('plataformas', 'Plataformas de delivery', 'Rappi, Uber Eats, Didi: pedidos con su comision y venta neta en reportes.', 0, 13),
  ('promociones', 'Promociones',            '2x1, paquetes, descuentos por horario y regalos, en caja y en linea.', 0, 14),
  ('multimoneda', 'Cobro en dolares',       'Efectivo en dolares con tipo de cambio por turno y corte en USD.', 0, 15)
ON CONFLICT (code) DO NOTHING;
