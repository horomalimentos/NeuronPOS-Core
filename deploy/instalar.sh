#!/usr/bin/env bash
# Instalacion inicial de NeuronPOS Core en el servidor (separado de Horom).
#
# Uso (en el servidor, con sudo disponible):
#   sudo git clone https://github.com/horomalimentos/NeuronPOS-Core /opt/neuronpos-core
#   sudo chown -R "$USER" /opt/neuronpos-core
#   cd /opt/neuronpos-core && bash deploy/instalar.sh
#
# Es seguro correrlo mas de una vez: no recrea la base de datos ni pisa un
# backend/.env que ya exista.
#
# Variables opcionales:
#   PLATFORM_DOMAIN (neuronpos.app), DB_NAME (neuronpos_core), DB_USER (neuron_app),
#   APP_PORT (8100), BILLING_TIMEZONE (America/Ciudad_Juarez)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_DOMAIN="${PLATFORM_DOMAIN:-neuronpos.app}"
DB_NAME="${DB_NAME:-neuronpos_core}"
DB_USER="${DB_USER:-neuron_app}"
APP_PORT="${APP_PORT:-8100}"
BILLING_TIMEZONE="${BILLING_TIMEZONE:-America/Ciudad_Juarez}"
ENV_FILE="$APP_DIR/backend/.env"

paso() { printf '\n==> %s\n' "$*"; }
falta() { command -v "$1" >/dev/null 2>&1 || { echo "Falta '$1' en el servidor." >&2; exit 1; }; }

for c in node npm psql pm2 openssl; do falta "$c"; done

# El puerto no debe estar ocupado por otro proceso (Horom usa otro).
if ss -ltn 2>/dev/null | grep -q ":$APP_PORT\b" && ! pm2 describe neuronpos-core >/dev/null 2>&1; then
  echo "El puerto $APP_PORT ya esta en uso. Usa APP_PORT=<otro> y ajusta el upstream de nginx." >&2
  exit 1
fi

paso "Base de datos $DB_NAME con rol $DB_USER (sin SUPERUSER ni BYPASSRLS)"
psql_admin() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA "$@"; }
DB_PASSWORD=""
if [ -f "$ENV_FILE" ]; then
  DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
if [ -z "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'")" ]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  psql_admin -c "CREATE ROLE $DB_USER LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '$DB_PASSWORD'"
elif [ -z "$DB_PASSWORD" ]; then
  echo "El rol $DB_USER ya existe pero no hay backend/.env con su contrasena." >&2
  echo "Restaura el .env o cambia la contrasena del rol a mano." >&2
  exit 1
fi
psql_admin -c "ALTER ROLE $DB_USER NOSUPERUSER NOBYPASSRLS"
if [ -z "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" ]; then
  psql_admin -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"
fi
# citext lo crea el administrador para no depender de permisos del rol.
psql_admin -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS citext"

paso "backend/.env"
if [ ! -f "$ENV_FILE" ]; then
  # umask solo para el .env (en un subshell); si se queda, el frontend
  # compilado sale sin permiso de lectura y nginx responde 403.
  ( umask 077
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=$APP_PORT

DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_POOL_MAX=10
REQUIRE_RLS_ROLE=true

JWT_SECRET=$(openssl rand -hex 48)
JWT_EXPIRES_IN=12h
CUSTOMER_JWT_EXPIRES_IN=30d

PLATFORM_DOMAIN=$PLATFORM_DOMAIN
RESERVED_SUBDOMAINS=www,app,api,admin,panel,static,cdn,mail
ALLOW_SLUG_HEADER=false
TRIAL_DAYS=14
CORS_ORIGINS=https://$PLATFORM_DOMAIN

PUBLIC_API_URL=https://$PLATFORM_DOMAIN
RESTAURANT_URL_TEMPLATE=https://{slug}.{domain}

# Cuenta de Clip de la plataforma: llenar antes de cobrar mensualidades.
CLIP_API_KEY=
CLIP_SECRET_KEY=
CLIP_WEBHOOK_SECRET=

# NO cambiar ni perder: cifra las cuentas de Clip de los restaurantes. Respaldala.
PAYMENT_SECRETS_KEY=$(openssl rand -base64 32)

BILLING_TIMEZONE=$BILLING_TIMEZONE
BILLING_AUTO=true
JOBS_ENABLED=true
ENV
  )
  echo "Creado $ENV_FILE (respalda PAYMENT_SECRETS_KEY y JWT_SECRET fuera del servidor)."
else
  echo "Ya existe, no se toca."
fi

paso "Dependencias y migraciones"
(cd "$APP_DIR/backend" && npm ci --omit=dev && npm run migrate)

paso "Frontend"
(cd "$APP_DIR/frontend" && npm ci && npm run build)

paso "pm2 (proceso neuronpos-core)"
if pm2 describe neuronpos-core >/dev/null 2>&1; then
  pm2 reload neuronpos-core --update-env
else
  pm2 start "$APP_DIR/backend/ecosystem.config.cjs" --env production
fi
pm2 save

paso "Listo"
cat <<MSG
Siguientes pasos (ver README, "Despliegue en el servidor"):
  1. DNS: registros A de $PLATFORM_DOMAIN y *.$PLATFORM_DOMAIN a la IP del servidor.
  2. Certificado comodin con certbot (reto DNS) y nginx con deploy/nginx-neuronpos.conf.
  3. Crear tu usuario del Panel:
       cd $APP_DIR/backend && npm run create-owner -- --email tu@correo.com --name "Alex"
  4. Llaves de Clip en backend/.env y webhook en el dashboard de Clip:
       https://$PLATFORM_DOMAIN/api/webhooks/clip/plataforma
MSG
