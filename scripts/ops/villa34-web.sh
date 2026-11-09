#!/usr/bin/env bash
# Villa 34 (deep): veroeffentlichte Web-Oberflaeche in den Projektordner legen.
# Laeuft auf der Oracle-VM als ubuntu (sudo), wird per SSH aus CI gestartet.
# Argument 1: Pfad zur HTML-Datei (Repository docs/app/index.html)
# Argument 2: optional Projektordner (sonst automatisch bestimmt)
set -euo pipefail

APP_DATEI="${1:?Pfad zur HTML-Datei fehlt}"
PROJEKT="${2:-}"
MARKER="mybabes-app.html"

echo "== DIAGNOSE =="
sudo ls -d /opt/villaforge 2>/dev/null || true
HUB_SRC=$(sudo grep -rln "export function projectDirectory" /opt/villaforge/server 2>/dev/null | head -1 || true)
echo "HUB-SRC ${HUB_SRC:-unbekannt}"
[ -n "${HUB_SRC:-}" ] && sudo grep -n "export function projectDirectory" -A 6 "$HUB_SRC" || true

if [ -z "$PROJEKT" ] && [ -n "${HUB_SRC:-}" ]; then
  PROJEKT=$(cd /opt/villaforge && node -e "
    const m = await import('${HUB_SRC#/opt/villaforge/}');
    console.log(m.projectDirectory(34));
  " 2>/dev/null | tail -1 || true)
fi

if [ -z "$PROJEKT" ] || [ ! -d "$PROJEKT" ]; then
  for k in /opt/villaforge/data/projects/34 /opt/villaforge/data/project/34 \
           /opt/villaforge/projects/34 /opt/villaforge/data/villas/34 \
           /opt/villaforge/data/deep/34; do
    [ -d "$k" ] && PROJEKT="$k" && break
  done
fi

if [ -z "$PROJEKT" ] || [ ! -d "$PROJEKT" ]; then
  echo "SUCHE per find:"
  sudo find /opt/villaforge -maxdepth 5 -type f -name package.json -printf '%h\n' 2>/dev/null | head -20
  sudo find /opt/villaforge -maxdepth 4 -type d -name 34 2>/dev/null | head -10
  echo "PROJEKT-NICHT-GEFUNDEN"
  exit 3
fi

echo "PROJEKT $PROJEKT"
sudo ls -la "$PROJEKT" | head -25
sudo test -f "$PROJEKT/package.json" && sudo cat "$PROJEKT/package.json" | head -40 || echo "KEIN package.json"

ZEIT=$(date +%Y%m%d-%H%M%S)
sudo cp -a "$PROJEKT/package.json" "$PROJEKT/package.json.bak-$ZEIT" 2>/dev/null || true
sudo install -m 0644 "$APP_DATEI" "$PROJEKT/$MARKER"
echo "APP-GROESSE $(sudo stat -c %s "$PROJEKT/$MARKER") Bytes"

# Build-Schritt auf die verifizierte Oberflaeche umstellen: kopiert die Datei
# unveraendert nach dist/index.html. Der alte Build bleibt als build:orig erhalten.
sudo tee "$PROJEKT/scripts/build-web.mjs" >/dev/null <<'JS'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
if (!existsSync('mybabes-app.html')) {
  console.error('mybabes-app.html fehlt');
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
copyFileSync('mybabes-app.html', 'dist/index.html');
console.log('dist/index.html = mybabes-app.html (' + (await import('node:fs')).statSync('dist/index.html').size + ' Bytes)');
JS

sudo node -e "
const fs = require('node:fs');
const p = '$PROJEKT/package.json';
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.scripts = pkg.scripts || {};
if (pkg.scripts.build && pkg.scripts.build !== 'node scripts/build-web.mjs') pkg.scripts['build:orig'] = pkg.scripts.build;
pkg.scripts.build = 'node scripts/build-web.mjs';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
console.log('BUILD-SKRIPT', pkg.scripts.build, '| vorher:', pkg.scripts['build:orig'] || '-');
"

# Sofort ausliefern, damit die Oberflaeche auch ohne Build erreichbar ist.
sudo mkdir -p "$PROJEKT/dist"
sudo install -m 0644 "$APP_DATEI" "$PROJEKT/dist/index.html"
echo "DIST-INDEX $(sudo stat -c %s "$PROJEKT/dist/index.html") Bytes"
echo "FERTIG $PROJEKT"
