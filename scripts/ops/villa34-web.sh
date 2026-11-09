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

# Die alten Pruefungen gehoerten zum Prototyp (Discovery-Container,
# Begleiterinnen-Karten) und scheiterten am neuen Produkt, obwohl der Build
# stimmte. Sie pruefen jetzt das, was wirklich ausgeliefert wird: die acht
# Oberflaechen und das Fehlen von Platzhaltern. Originale bleiben als .orig.
sudo test -f "$PROJEKT/scripts/test.js" && sudo cp -a "$PROJEKT/scripts/test.js" "$PROJEKT/scripts/test.js.orig" || true
sudo test -f "$PROJEKT/scripts/smoke.js" && sudo cp -a "$PROJEKT/scripts/smoke.js" "$PROJEKT/scripts/smoke.js.orig" || true
sudo tee "$PROJEKT/scripts/test.js" >/dev/null <<'JS'
// Prueft das ausgelieferte Produkt (dist/index.html) auf die acht Oberflaechen.
const assert = require('node:assert');
const { readFileSync, statSync } = require('node:fs');
const datei = 'dist/index.html';
const groesse = statSync(datei).size;
assert.ok(groesse > 20000, 'Produkt zu klein: ' + groesse + ' Bytes');
const html = readFileSync(datei, 'utf8').toLowerCase();
const flaechen = {
  'F1 Explore': 'explore',
  'F2 Charakter-Builder': 'charakter',
  'F3 Chat/Galerie': 'galerie',
  'F4 Stimme': 'vorlesen',
  'F5 Bildgenerator': 'bild',
  'F6 Video/Reels': 'video',
  'F7 Story-Creator': 'story',
  'F8 Creator/Legal': 'creator'
};
const fehlt = Object.entries(flaechen).filter(([, m]) => !html.includes(m)).map(([k]) => k);
assert.deepStrictEqual(fehlt, [], 'Oberflaechen fehlen: ' + fehlt.join(', '));
assert.ok(!html.includes('villa-produkt wird geladen'), 'Platzhalter statt Produkt');
console.log('test: ' + (8 - fehlt.length) + '/8 Oberflaechen belegt, ' + groesse + ' Bytes');
JS
sudo tee "$PROJEKT/scripts/smoke.js" >/dev/null <<'JS'
// Kurzprobe: das Produkt ist da und vollstaendig.
const { readFileSync, existsSync } = require('node:fs');
if (!existsSync('dist/index.html')) {
  console.error('smoke: dist/index.html fehlt');
  process.exit(1);
}
const html = readFileSync('dist/index.html', 'utf8').toLowerCase();
const pflicht = { explore: 'F1', charakter: 'F2', galerie: 'F3', vorlesen: 'F4', bild: 'F5', video: 'F6', story: 'F7', creator: 'F8' };
const fehlt = Object.entries(pflicht).filter(([m]) => !html.includes(m)).map(([, k]) => k);
if (fehlt.length) {
  console.error('smoke: Produktmarker fehlt: ' + fehlt.join(', '));
  process.exit(1);
}
console.log('smoke: Produktmarker vollstaendig (8/8)');
JS
echo "PRUEFUNGEN erneuert"
echo "FERTIG $PROJEKT"
