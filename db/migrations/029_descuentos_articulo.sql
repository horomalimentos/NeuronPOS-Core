-- 012: Descuento por articulo (como en Horom: a la orden o a un articulo).
--
-- El descuento de cada linea se calcula sobre su importe (en % o $) y se
-- resta despues de las promociones; el descuento a la cuenta va al final sobre
-- lo que queda. discount_by es quien lo aplico o, si paso el limite del
-- cajero, el gerente que lo autorizo con su PIN.

ALTER TABLE order_items
  ADD COLUMN discount_type   text CHECK (discount_type IN ('amount', 'percent')),
  ADD COLUMN discount_value  numeric(10,2) CHECK (discount_value IS NULL OR discount_value > 0),
  ADD COLUMN discount_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN discount_reason text CHECK (discount_reason IS NULL OR length(discount_reason) <= 300),
  ADD COLUMN discount_by     uuid,
  ADD CONSTRAINT order_items_discount_by_fk FOREIGN KEY (restaurant_id, discount_by)
    REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE orders ADD COLUMN item_discount numeric(10,2) NOT NULL DEFAULT 0 CHECK (item_discount >= 0);
