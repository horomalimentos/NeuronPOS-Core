-- 002: Catalogo inicial de modulos. Los precios quedan en 0 como marcador;
-- el dueno de la plataforma los ajusta desde el Panel NeuronPOS.
INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('pos',          'Punto de venta',             'POS para tomar ordenes, cobrar y hacer cortes de caja.',              0, 10),
  ('landing',      'Sitio web',                  'Pagina web del restaurante con menu, ubicacion y contacto.',           0, 20),
  ('portal',       'Portal de clientes',         'Portal de clientes y pedidos en linea.',                               0, 30),
  ('rh',           'Recursos humanos',           'Recursos humanos y nomina: asistencia, prenomina y expedientes.',      0, 40),
  ('empleado_mes', 'Empleado del mes',           'Reconocimiento y votacion del empleado del mes.',                      0, 50),
  ('domicilios',   'Domicilios',                 'Entregas a domicilio con repartidores propios o con Horom.',           0, 60)
ON CONFLICT (code) DO NOTHING;
