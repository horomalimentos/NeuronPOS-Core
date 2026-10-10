-- 021: Bot de WhatsApp (modulo 'whatsapp'), adaptado de Horom
-- (whatsappBot.js, whatsappClient.js, botConversations.js).
--
-- Cada restaurante conecta su numero de WhatsApp Business (Cloud API de
-- Meta). El webhook es uno solo para toda la plataforma y se enruta por el
-- phone_number_id del numero que recibio el mensaje. El token de acceso y el
-- app secret se guardan cifrados (PAYMENT_SECRETS_KEY).
--
-- El bot toma pedidos en el chat (sucursal, productos, modificadores,
-- recoger o domicilio, pago) y los crea como pedidos en linea normales
-- (source 'web', channel 'whatsapp'); avisa al cliente por WhatsApp cuando
-- su pedido se acepta, esta listo o va en camino. Si el cliente pide una
-- persona, la conversacion pasa al panel del restaurante.

-- Por donde llego un pedido en linea (null = sitio, pedidos anteriores).
ALTER TABLE orders ADD COLUMN channel text CHECK (channel IN ('web', 'whatsapp'));

CREATE TABLE whatsapp_settings (
  restaurant_id    uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  -- Unico en toda la plataforma: con el se sabe de que restaurante es cada mensaje.
  phone_number_id  text UNIQUE CHECK (phone_number_id ~ '^[0-9]{5,30}$'),
  display_phone    text CHECK (length(display_phone) <= 30),
  access_token_enc text,
  -- Solo si el restaurante usa su propia app de Meta; si no, WHATSAPP_APP_SECRET.
  app_secret_enc   text,
  verify_token     text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  bot_enabled      boolean NOT NULL DEFAULT true,
  welcome_text     text CHECK (length(welcome_text) <= 600),
  -- [{ question, answer }] (maximo 6)
  faqs             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(faqs) = 'array'),
  notify_status    boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (phone_number_id IS NOT NULL AND access_token_enc IS NOT NULL))
);

CREATE TABLE whatsapp_conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Numero del cliente como lo manda WhatsApp (solo digitos, con lada de pais).
  wa_id                text NOT NULL CHECK (wa_id ~ '^[0-9]{6,20}$'),
  profile_name         text CHECK (length(profile_name) <= 120),
  -- bot: responde el bot; humano: lo atiende el personal desde el panel.
  mode                 text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'humano')),
  needs_attention      boolean NOT NULL DEFAULT false,
  state                text NOT NULL DEFAULT 'inicio',
  context              jsonb NOT NULL DEFAULT '{}',
  unread               integer NOT NULL DEFAULT 0,
  last_inbound_at      timestamptz,
  last_message_at      timestamptz NOT NULL DEFAULT now(),
  last_message_preview text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, wa_id),
  UNIQUE (restaurant_id, id)
);
CREATE INDEX whatsapp_conversations_recent_idx ON whatsapp_conversations (restaurant_id, last_message_at DESC);

CREATE TABLE whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  sender          text NOT NULL CHECK (sender IN ('cliente', 'bot', 'personal')),
  type            text NOT NULL,
  body            text,
  payload         jsonb,
  wa_message_id   text,
  status          text NOT NULL DEFAULT 'enviado' CHECK (status IN ('recibido', 'enviado', 'entregado', 'leido', 'fallido')),
  error           text,
  sent_by         uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, conversation_id) REFERENCES whatsapp_conversations (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, sent_by) REFERENCES users (restaurant_id, id) DEFERRABLE INITIALLY DEFERRED
);
-- Meta puede repetir un webhook: cada mensaje se procesa una sola vez.
CREATE UNIQUE INDEX whatsapp_messages_wa_id_idx ON whatsapp_messages (restaurant_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX whatsapp_messages_conv_idx ON whatsapp_messages (restaurant_id, conversation_id, created_at);

-- Avisos al cliente de sus pedidos de WhatsApp (se mandan despues del COMMIT).
CREATE TABLE whatsapp_outbox (
  id            bigserial PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('pagado', 'aceptado', 'listo', 'en_camino', 'rechazado', 'cancelado')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX whatsapp_outbox_pending_idx ON whatsapp_outbox (id) WHERE sent_at IS NULL;

CREATE OR REPLACE FUNCTION orders_whatsapp_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF NEW.channel IS DISTINCT FROM 'whatsapp' THEN
    RETURN NULL;
  END IF;
  IF OLD.online_payment_status = 'pendiente' AND NEW.online_payment_status = 'pagado' THEN
    INSERT INTO whatsapp_outbox (restaurant_id, order_id, kind) VALUES (NEW.restaurant_id, NEW.id, 'pagado');
  END IF;
  IF NEW.online_status = 'aceptada' AND OLD.online_status IS DISTINCT FROM 'aceptada' THEN
    k := 'aceptado';
  ELSIF NEW.online_status = 'rechazada' AND OLD.online_status IS DISTINCT FROM 'rechazada' THEN
    k := 'rechazado';
  ELSIF NEW.status = 'cancelada' AND OLD.status <> 'cancelada' AND NEW.online_status = 'aceptada' THEN
    k := 'cancelado';
  END IF;
  IF k IS NOT NULL THEN
    INSERT INTO whatsapp_outbox (restaurant_id, order_id, kind) VALUES (NEW.restaurant_id, NEW.id, k);
  END IF;
  IF NEW.status <> 'cancelada' AND NEW.ready_at IS NOT NULL AND OLD.ready_at IS NULL THEN
    INSERT INTO whatsapp_outbox (restaurant_id, order_id, kind) VALUES (NEW.restaurant_id, NEW.id, 'listo');
  END IF;
  IF NEW.order_type = 'domicilio' AND NEW.status <> 'cancelada'
     AND NEW.dispatched_at IS NOT NULL AND OLD.dispatched_at IS NULL THEN
    INSERT INTO whatsapp_outbox (restaurant_id, order_id, kind) VALUES (NEW.restaurant_id, NEW.id, 'en_camino');
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER orders_whatsapp_events
  AFTER UPDATE OF online_status, online_payment_status, status, ready_at, dispatched_at ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_whatsapp_events();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_settings', 'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_can_access(restaurant_id)) WITH CHECK (app_can_access(restaurant_id))',
      t
    );
  END LOOP;
END
$$;

INSERT INTO modules (code, name, description, monthly_price_mxn, sort_order) VALUES
  ('whatsapp', 'Bot de WhatsApp',
   'Tu número de WhatsApp Business atiende solo: toma pedidos en el chat (menú, modificadores, recoger o domicilio, pago), responde preguntas frecuentes, informa el estado del pedido y avisa cuando está listo o va en camino. Si el cliente pide una persona, la conversación pasa a tu panel.', 300, 36)
ON CONFLICT (code) DO NOTHING;
