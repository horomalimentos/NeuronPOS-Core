-- 048: Chat del equipo (como el chat del tablero de Horom), modulo "chat".
--
-- Un muro de mensajes para todo el personal del restaurante: cualquiera
-- publica y responde; el gerente fija mensajes arriba y borra lo que no va.
-- Un mensaje puede ser para todas las sucursales (branch_id NULL) o para una;
-- el personal solo ve los de sus sucursales.

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('chat', 'Chat del equipo', 'Muro de mensajes del personal con respuestas y mensajes fijados por sucursal.', 0, 55)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE chat_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid,
  author_id     uuid NOT NULL,
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  pinned        boolean NOT NULL DEFAULT false,
  edited_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Ultima actividad (publicacion o respuesta): ordena el muro.
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, author_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_posts_feed_idx ON chat_posts (restaurant_id, pinned DESC, last_activity_at DESC);

CREATE TABLE chat_replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  post_id       uuid NOT NULL,
  author_id     uuid NOT NULL,
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, post_id)   REFERENCES chat_posts (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, author_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_replies_post_idx ON chat_replies (post_id, created_at);

-- Hasta donde leyo cada usuario (para el contador de mensajes nuevos).
CREATE TABLE chat_reads (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, user_id),
  FOREIGN KEY (restaurant_id, user_id) REFERENCES users (restaurant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_posts', 'chat_replies', 'chat_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))', t);
  END LOOP;
END $$;
