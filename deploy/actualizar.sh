#!/usr/bin/env bash
# Actualiza NeuronPOS Core en el servidor: trae main, migra, compila y recarga.
# Uso: cd /opt/neuronpos-core && bash deploy/actualizar.sh
#
# Para que tarde menos, solo reinstala dependencias cuando cambia el
# package-lock.json y solo recompila el frontend cuando cambia frontend/.
# FORZAR=1 bash deploy/actualizar.sh hace todo desde cero.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

INICIO=$SECONDS
paso() { echo "[$((SECONDS - INICIO))s] $*"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Hay cambios locales sin commit en $APP_DIR; revisalos antes de actualizar." >&2
  git status --short
  exit 1
fi

ANTES="$(git rev-parse HEAD)"
paso "Trayendo main"
git pull --ff-only origin main

# Reinstala solo si el lockfile no coincide con el de la ultima instalacion.
instalar() {
  local dir="$1"; shift
  local marca="$dir/node_modules/.neuronpos-lock"
  local hash
  hash="$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1) $*"
  if [ "${FORZAR:-0}" != "1" ] && [ -f "$marca" ] && [ "$(cat "$marca")" = "$hash" ]; then
    paso "$dir: dependencias sin cambios, no se reinstalan"
    return
  fi
  paso "$dir: npm ci $*"
  (cd "$dir" && npm ci --no-audit --no-fund "$@")
  echo "$hash" > "$marca"
}

instalar backend --omit=dev
paso "Migrando la base"
(cd backend && npm run migrate)

instalar frontend
COMPILADO=frontend/node_modules/.neuronpos-build
if [ "${FORZAR:-0}" != "1" ] && [ -f frontend/dist/index.html ] && [ -f "$COMPILADO" ] \
   && git diff --quiet "$(cat "$COMPILADO")" HEAD -- frontend 2>/dev/null; then
  paso "frontend: sin cambios desde $(cut -c1-7 "$COMPILADO"), no se recompila"
else
  paso "Compilando el frontend"
  (cd frontend && npm run build)
  git rev-parse HEAD > "$COMPILADO"
fi

paso "Recargando pm2"
pm2 reload neuronpos-core --update-env
pm2 save
paso "NeuronPOS Core actualizado de ${ANTES:0:7} a $(git rev-parse --short HEAD)."
