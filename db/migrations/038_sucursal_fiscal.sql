-- 026: Impuesto y ticket por sucursal. En la franja fronteriza el IVA es del
-- 8 % y en el resto del pais del 16 %: cada sucursal puede tener su tasa
-- (NULL = la del restaurante) y su propio encabezado y pie del ticket (razon
-- social, RFC, direccion...). Las ordenes guardan la tasa con que se crearon.

ALTER TABLE branches
  ADD COLUMN tax_rate_pct  numeric(5,2) CHECK (tax_rate_pct IS NULL OR tax_rate_pct BETWEEN 0 AND 100),
  ADD COLUMN ticket_header text CHECK (ticket_header IS NULL OR length(ticket_header) <= 500),
  ADD COLUMN ticket_footer text CHECK (ticket_footer IS NULL OR length(ticket_footer) <= 500);
