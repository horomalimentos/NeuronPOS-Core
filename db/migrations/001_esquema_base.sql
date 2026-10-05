-- 001: Esquema base multi-restaurante de NeuronPOS Core.
--
-- Modelo: una sola base de datos compartida. Cada tabla que pertenece a un
-- restaurante lleva restaurant_id y esta protegida con Row Level Security
-- (ver 003_rls.sql). Las tablas de plataforma (platform_admins, restaurants,
-- modules) no son "de un restaurante" y no llevan RLS: solo se tocan desde
-- codigo de plataforma o desde la resolucion del tenant.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Plataforma
-- ---------------------------------------------------------------------------

-- Cuentas del dueno de la plataforma (no pertenecen a ningun restaurante).
CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Subdominio: slug.<PLATFORM_DOMAIN>
  slug            text NOT NULL UNIQUE
                  CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  name            text NOT NULL,
  -- Dominio propio opcional (ej. www.horomsushi.com), siempre en minusculas.
  custom_domain   text UNIQUE CHECK (custom_domain IS NULL OR custom_domain = lower(custom_domain)),
  logo_url        text,
  primary_color   text NOT NULL DEFAULT '#C8202A' CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text NOT NULL DEFAULT '#1E1E1E' CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  status          text NOT NULL DEFAULT 'trial' CHECK (status IN ('active', 'suspended', 'trial')),
  trial_ends_at   timestamptz,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Catalogo de modulos que se venden. El dueno de la plataforma fija el precio.
CREATE TABLE modules (
  code              text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]+$'),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  monthly_price_mxn numeric(10,2) NOT NULL DEFAULT 0 CHECK (monthly_price_mxn >= 0),
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tablas por restaurante (todas con restaurant_id + RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE restaurant_modules (
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  module_code      text NOT NULL REFERENCES modules(code) ON UPDATE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  -- Si no es NULL sustituye al precio de catalogo para este restaurante.
  custom_price_mxn numeric(10,2) CHECK (custom_price_mxn IS NULL OR custom_price_mxn >= 0),
  -- Descuento porcentual (0-100) sobre el precio efectivo.
  discount_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  started_at       timestamptz,
  ends_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, module_code)
);

CREATE TABLE delivery_settings (
  restaurant_id   uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- propio = repartidores del restaurante; horom = servicio de repartidores Horom.
  mode            text NOT NULL DEFAULT 'propio' CHECK (mode IN ('propio', 'horom')),
  horom_fee_type  text NOT NULL DEFAULT 'fixed' CHECK (horom_fee_type IN ('fixed', 'percent')),
  horom_fee_value numeric(10,2) NOT NULL DEFAULT 0 CHECK (horom_fee_value >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (horom_fee_type <> 'percent' OR horom_fee_value <= 100)
);

CREATE TABLE branches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  address       text,
  phone         text,
  timezone      text NOT NULL DEFAULT 'America/Ciudad_Juarez',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Permite FKs compuestas (restaurant_id, id) para que una relacion nunca
  -- cruce de restaurante.
  UNIQUE (restaurant_id, id)
);
CREATE INDEX branches_restaurant_idx ON branches (restaurant_id);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'gerente', 'cajero', 'mesero', 'cocina', 'repartidor')),
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, email),
  UNIQUE (restaurant_id, id)
);

-- Acceso de cada usuario a sucursales. Los admin tienen acceso a todas
-- implicitamente; para el resto esta tabla es la fuente de verdad.
CREATE TABLE user_branches (
  restaurant_id uuid NOT NULL,
  user_id       uuid NOT NULL,
  branch_id     uuid NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (restaurant_id, user_id)   REFERENCES users (restaurant_id, id)    ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_branches_restaurant_idx ON user_branches (restaurant_id);

-- Facturas de la suscripcion mensual. Placeholder: todavia no hay
-- integracion con un proveedor de pagos.
CREATE TABLE subscription_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  period        date NOT NULL CHECK (extract(day FROM period) = 1), -- primer dia del mes
  amount_mxn    numeric(10,2) NOT NULL CHECK (amount_mxn >= 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
  detail        jsonb NOT NULL DEFAULT '[]'::jsonb,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, period)
);
