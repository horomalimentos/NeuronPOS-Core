-- Nayo: los restaurantes nuevos quedan pendientes hasta que el Panel los
-- aprueba, igual que los repartidores. Mientras no esten aprobados, los
-- clientes no los ven aunque la ficha este publicada.
ALTER TABLE marketplace_listings
  ADD COLUMN approval_status text NOT NULL DEFAULT 'pendiente'
    CHECK (approval_status IN ('pendiente', 'aprobado', 'rechazado')),
  ADD COLUMN approval_note text,
  ADD COLUMN reviewed_at timestamptz;

-- Las fichas que ya existian siguen visibles.
UPDATE marketplace_listings SET approval_status = 'aprobado', reviewed_at = now();

-- Solo el Panel aprueba o rechaza; el restaurante no puede aprobarse solo.
CREATE OR REPLACE FUNCTION marketplace_listings_guard_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_platform() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.approval_status := 'pendiente';
    NEW.approval_note := NULL;
    NEW.reviewed_at := NULL;
  ELSIF NEW.approval_status IS DISTINCT FROM OLD.approval_status
     OR NEW.approval_note IS DISTINCT FROM OLD.approval_note
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    RAISE EXCEPTION 'Solo el Panel puede aprobar o rechazar la ficha' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER marketplace_listings_guard_approval BEFORE INSERT OR UPDATE ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION marketplace_listings_guard_approval();
