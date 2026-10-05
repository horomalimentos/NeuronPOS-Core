#!/usr/bin/env bash
# Actualiza NeuronPOS Core en el servidor: trae main, migra, compila y recarga.
# Uso: cd /opt/neuronpos-core && bash deploy/actualizar.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Hay cambios locales sin commit en $APP_DIR; revisalos antes de actualizar." >&2
  git status --short
  exit 1
fi

git pull --ff-only origin main
(cd backend && npm ci --omit=dev && npm run migrate)
(cd frontend && npm ci && npm run build)
pm2 reload neuronpos-core --update-env
pm2 save
echo "NeuronPOS Core actualizado a $(git rev-parse --short HEAD)."
