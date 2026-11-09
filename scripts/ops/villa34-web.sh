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
DB=""
for k in $(sudo find /opt/villaforge -maxdepth 4 -name '*.db' -not -path '*/node_modules/*' 2>/dev/null); do
  if sudo sqlite3 "$k" "SELECT name FROM sqlite_master WHERE type='table' AND name='villas'" 2>/dev/null | grep -qx villas; then DB="$k"; break; fi
done
echo "DB ${DB:-nicht gefunden}"
if [ -n "$DB" ]; then
  sudo sqlite3 -header -separator ' | ' "$DB" "SELECT id, status, source_path FROM villas WHERE id=34" || true
  if [ -z "$PROJEKT" ]; then
    PROJEKT=$(sudo sqlite3 "$DB" "SELECT source_path FROM villas WHERE id=34" 2>/dev/null | tr -d '\r' || true)
  fi
fi

if [ -z "$PROJEKT" ] || [ ! -d "$PROJEKT" ]; then
  echo "SOURCE_PATH unbrauchbar ($PROJEKT), suche Projektordner:"
  sudo find /opt/villaforge -maxdepth 3 -type d \( -name 'villa-34' -o -name '34' -o -name '*villa*34*' \) -not -path '*/node_modules/*' 2>/dev/null | head -10
  for k in /opt/villaforge/workspace/villa-34 /opt/villaforge/projects/villa-34 \
           /opt/villaforge/data/workspace/villa-34 /opt/villaforge/pilot/villa-34; do
    [ -d "$k" ] && PROJEKT="$k" && break
  done
fi

if [ -z "$PROJEKT" ] || [ ! -d "$PROJEKT" ]; then
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
# Die APK-Strasse nimmt die erste index.html im Artefakt. Ein alter Prototyp an
# der Wurzel wuerde sie gewinnen, deshalb tragen Wurzel und dist denselben
# Produktstand: eine Quelle, zwei Pfade.
sudo install -m 0644 "$APP_DATEI" "$PROJEKT/index.html"
echo "DIST-INDEX $(sudo stat -c %s "$PROJEKT/dist/index.html") Bytes | WURZEL $(sudo stat -c %s "$PROJEKT/index.html") Bytes"
echo "FERTIG $PROJEKT"
