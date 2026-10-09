-- 010: Canales de venta (plataformas de delivery: Rappi, Uber Eats, Didi...).
--
-- Como en Horom: cada restaurante da de alta sus plataformas con su comision.
-- Una orden de caja para llevar o a domicilio puede venir de una plataforma;
-- sin canal es venta propia ("Local"). La orden guarda el % de comision del
-- momento (cambiarlo despues no reescribe ventas pasadas) y el numero de pedido
-- de la plataforma. Los reportes muestran venta, comision y venta neta.

CREATE TABLE sales_channels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color                 text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  commission_pct        numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
  -- Metodos con los que se cobra (vacio = todos). Ej. solo "Rappi (pagado)".
  payment_method_ids    uuid[] NOT NULL DEFAULT '{}',
  -- Pide el numero de pedido de la plataforma / la direccion de entrega.
  requires_order_number boolean NOT NULL DEFAULT true,
  requires_address      boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);
CREATE UNIQUE INDEX sales_channels_name_idx ON sales_channels (restaurant_id, lower(name));

ALTER TABLE orders
  ADD COLUMN channel_id             uuid,
  ADD COLUMN channel_order_number   text CHECK (channel_order_number IS NULL OR length(channel_order_number) <= 60),
  ADD COLUMN channel_commission_pct numeric(5,2) NOT NULL DEFAULT 0
    CHECK (channel_commission_pct BETWEEN 0 AND 100),
  ADD CONSTRAINT orders_channel_fk FOREIGN KEY (restaurant_id, channel_id)
    REFERENCES sales_channels (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT orders_channel_type CHECK (channel_id IS NULL OR order_type IN ('para_llevar', 'domicilio'));

ALTER TABLE sales_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_channels
  USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id));
