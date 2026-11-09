#!/usr/bin/env bash
# TASTE-/SPION-Artefakte in den Deep-Projektordner der Villa 34 legen.
# Laeuft auf der Oracle-VM als ubuntu (sudo), gestartet per SSH aus CI.
# Argumente: Zielordner, taste.json, spion.json
set -euo pipefail

ZIEL="${1:?Zielordner fehlt}"
TASTE="${2:?taste.json fehlt}"
SPION="${3:?spion.json fehlt}"

sudo mkdir -p "$ZIEL"
sudo install -m 0644 "$TASTE" "$ZIEL/taste.json"
sudo install -m 0644 "$SPION" "$ZIEL/spion.json"

# Gueltiges JSON beweisen, nicht annehmen.
sudo node -e "
const fs=require('node:fs');
for (const n of ['taste.json','spion.json']) {
  const p='$ZIEL/'+n;
  const d=JSON.parse(fs.readFileSync(p,'utf8'));
  const anzahl=(d.statements||d.competitors||[]).length;
  console.log(n, fs.statSync(p).size+' Bytes', 'Eintraege', anzahl);
}
"
sudo ls -la "$ZIEL" | head -12
echo "ARTEFAKTE $ZIEL"
