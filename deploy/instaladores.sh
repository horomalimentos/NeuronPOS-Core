#!/usr/bin/env bash
# Compila los instaladores de NeuronPOS y Neuron KDS y los publica en
# https://neuronpos.app/descargas (archivos en /api/descargas, servidos por el
# backend desde ./descargas).
#
#   Escritorio: Windows (.exe) y Linux (.AppImage), con actualizacion automatica.
#   Android:    NeuronPOS.apk y NeuronKDS.apk; la app avisa cuando hay version nueva.
#
# Uso (en el servidor, despues de deploy/actualizar.sh):
#   cd /opt/neuronpos-core && bash deploy/instaladores.sh            # todo
#   bash deploy/instaladores.sh escritorio                          # solo escritorio
#   bash deploy/instaladores.sh android                             # solo Android
#
# Requisitos: Node 20+, wine (para el .exe de Windows), Java 17+ y el SDK de
# Android (ANDROID_HOME; si no esta, se busca el mismo que usa Horom).
#
# Firma de Android: la llave se guarda FUERA del repositorio, en
# $NEURON_SECRETS (por omision /opt/neuronpos-core-secrets). Si no existe se
# crea una nueva. RESPALDALA: sin ella no se pueden publicar actualizaciones
# de la app de Android (habria que desinstalar y volver a instalar).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${DOWNLOADS_DIR:-$APP_DIR/descargas}"
SECRETS="${NEURON_SECRETS:-/opt/neuronpos-core-secrets}"
PUBLIC_URL="${PUBLIC_DOWNLOADS_URL:-https://neuronpos.app/api/descargas}"
WHAT="${1:-todo}"

cd "$APP_DIR"
COUNT="$(git rev-list --count HEAD)"
VERSION="1.0.${COUNT}"
echo "==> Versión ${VERSION} ($(git rev-parse --short HEAD))"
mkdir -p "$OUT/pos" "$OUT/kds" "$OUT/android"

# Deja solo las 2 versiones mas recientes de cada archivo versionado.
prune() {
  local dir="$1" pattern="$2"
  # shellcheck disable=SC2012
  { ls -1t "$dir"/$pattern 2>/dev/null || true; } | tail -n +3 | xargs -r rm -f
}

# ---------------------------------------------------------------------------
# Escritorio
# ---------------------------------------------------------------------------
build_desktop() {
  echo "==> Escritorio: instalando dependencias"
  cd "$APP_DIR/apps/desktop"
  npm ci --no-audit --no-fund
  rm -rf dist

  local targets=(--linux)
  if command -v wine >/dev/null 2>&1; then
    targets+=(--win)
  else
    echo "AVISO: no hay wine; se omite el instalador de Windows (sudo apt install wine)." >&2
  fi

  for mode in pos kds; do
    echo "==> Escritorio: compilando ${mode}"
    npx electron-builder --config "builder-${mode}.json" "${targets[@]}" --publish never \
      -c.extraMetadata.version="$VERSION"
    local src="dist/${mode}" dst="$OUT/${mode}"
    # Archivos de actualizacion automatica + instaladores
    cp -f "$src"/latest*.yml "$dst"/ 2>/dev/null || true
    cp -f "$src"/*.exe "$src"/*.exe.blockmap "$src"/*.AppImage "$dst"/ 2>/dev/null || true
  done

  prune "$OUT/pos" 'NeuronPOS-Setup-*.exe'
  prune "$OUT/pos" 'NeuronPOS-Setup-*.exe.blockmap'
  prune "$OUT/pos" 'NeuronPOS-*-linux.AppImage'
  prune "$OUT/kds" 'NeuronKDS-Setup-*.exe'
  prune "$OUT/kds" 'NeuronKDS-Setup-*.exe.blockmap'
  prune "$OUT/kds" 'NeuronKDS-*-linux.AppImage'
  cd "$APP_DIR"
}

# ---------------------------------------------------------------------------
# Android
# ---------------------------------------------------------------------------
find_sdk() {
  for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && { echo "$d"; return; }
  done
  if [ -f /opt/restaurante/android/local.properties ]; then
    local d
    d="$(sed -n 's/^sdk\.dir=//p' /opt/restaurante/android/local.properties | head -1)"
    [ -n "$d" ] && [ -d "$d" ] && { echo "$d"; return; }
  fi
  for d in "$HOME/Android/Sdk" /opt/android-sdk /usr/lib/android-sdk /opt/android; do
    [ -d "$d" ] && { echo "$d"; return; }
  done
}

ensure_keystore() {
  if [ ! -f "$SECRETS/android.jks" ]; then
    echo "==> Android: creando la llave de firma en $SECRETS (RESPÁLDALA)"
    mkdir -p "$SECRETS"
    chmod 700 "$SECRETS"
    local pass
    pass="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    ( umask 077; printf '%s' "$pass" > "$SECRETS/android.pass" )
    keytool -genkeypair -v -keystore "$SECRETS/android.jks" -alias neuronpos -keyalg RSA -keysize 2048 \
      -validity 10000 -storepass "$pass" -keypass "$pass" \
      -dname "CN=NeuronPOS, O=NeuronPOS, L=Ciudad Juarez, ST=Chihuahua, C=MX" >/dev/null
    chmod 600 "$SECRETS/android.jks"
  fi
}

build_android() {
  local sdk
  sdk="$(find_sdk || true)"
  if [ -z "$sdk" ]; then
    echo "ERROR: no encontré el SDK de Android. Define ANDROID_HOME." >&2
    return 1
  fi
  ensure_keystore
  echo "==> Android: compilando con el SDK en $sdk"
  cd "$APP_DIR/apps/android"
  printf 'sdk.dir=%s\n' "$sdk" > local.properties
  chmod +x gradlew
  ./gradlew --no-daemon clean assemblePosRelease assembleKdsRelease \
    -PneuronVersionName="$VERSION" -PneuronVersionCode="$COUNT" \
    -PneuronKeystore="$SECRETS/android.jks" -PneuronKeyAlias=neuronpos \
    -PneuronKeystorePassword="$(cat "$SECRETS/android.pass")"

  local pos kds
  pos="$(ls app/build/outputs/apk/pos/release/*.apk | head -1)"
  kds="$(ls app/build/outputs/apk/kds/release/*.apk | head -1)"
  cp -f "$pos" "$OUT/android/NeuronPOS-${VERSION}.apk"
  cp -f "$kds" "$OUT/android/NeuronKDS-${VERSION}.apk"
  for mode in pos kds; do
    local file
    [ "$mode" = pos ] && file="NeuronPOS-${VERSION}.apk" || file="NeuronKDS-${VERSION}.apk"
    printf '{"versionName":"%s","versionCode":%s,"url":"%s/android/%s"}\n' \
      "$VERSION" "$COUNT" "$PUBLIC_URL" "$file" > "$OUT/android/latest-${mode}.json"
  done
  prune "$OUT/android" 'NeuronPOS-*.apk'
  prune "$OUT/android" 'NeuronKDS-*.apk'
  cd "$APP_DIR"
}

case "$WHAT" in
  escritorio) build_desktop ;;
  android) build_android ;;
  todo) build_desktop; build_android ;;
  *) echo "Uso: $0 [todo|escritorio|android]" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# index.json: lo que lee la pagina neuronpos.app/descargas
# ---------------------------------------------------------------------------
latest() { { ls -1t "$1"/$2 2>/dev/null || true; } | head -1 | xargs -r basename; }
entry() {
  local file="$1" dir="$2"
  if [ -n "$file" ]; then printf '"%s/%s/%s"' "$PUBLIC_URL" "$dir" "$file"; else printf 'null'; fi
}
cat > "$OUT/index.json" <<JSON
{
  "version": "$(sed -n 's/.*"versionName":"\([^"]*\)".*/\1/p' "$OUT/android/latest-pos.json" 2>/dev/null || true)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pos": {
    "windows": $(entry "$(latest "$OUT/pos" 'NeuronPOS-Setup-*.exe')" pos),
    "linux": $(entry "$(latest "$OUT/pos" 'NeuronPOS-*-linux.AppImage')" pos),
    "android": $(entry "$(latest "$OUT/android" 'NeuronPOS-*.apk')" android)
  },
  "kds": {
    "windows": $(entry "$(latest "$OUT/kds" 'NeuronKDS-Setup-*.exe')" kds),
    "linux": $(entry "$(latest "$OUT/kds" 'NeuronKDS-*-linux.AppImage')" kds),
    "android": $(entry "$(latest "$OUT/android" 'NeuronKDS-*.apk')" android)
  }
}
JSON
# La version de la pagina es la del escritorio si no hubo Android.
if ! grep -q '"version": "1' "$OUT/index.json"; then
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$OUT/index.json"
fi

# Si se corrio como root, los archivos quedan del dueno de la app.
owner="$(stat -c %U "$APP_DIR")"
[ "$(id -u)" = 0 ] && [ "$owner" != root ] && chown -R "$owner": "$OUT" "$APP_DIR/apps" 2>/dev/null || true

echo "==> Listo. Instaladores en $OUT"
echo "    Página de descargas: https://neuronpos.app/descargas"
