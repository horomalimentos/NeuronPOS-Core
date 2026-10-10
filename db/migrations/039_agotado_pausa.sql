-- 027: "Agotado hasta" y pausa de pedidos en linea (como en Horom).
--
--  * Un producto agotado en una sucursal puede tener hora de regreso: pasada
--    esa hora vuelve a estar disponible solo (NULL = hasta que alguien lo active).
--  * Una sucursal puede pausar los pedidos en linea por un rato (cocina
--    saturada, falta de repartidor...) con un mensaje para el cliente.

ALTER TABLE menu_item_branches ADD COLUMN unavailable_until timestamptz;

ALTER TABLE branch_online_settings
  ADD COLUMN paused_until   timestamptz,
  ADD COLUMN paused_message text CHECK (paused_message IS NULL OR length(paused_message) <= 200);
