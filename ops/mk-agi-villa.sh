#!/usr/bin/env bash
# AGI-Agenten-Villa auf der Oracle-Instanz einrichten (idempotent).
# Laeuft als ubuntu mit sudo. Aufruf via oracle-token.yml (mode: agivilla).
set -uo pipefail
DEST=/opt/villaforge
WS=$DEST/workspace
REPO=$WS/agi-agenten
HUB="http://127.0.0.1:12000"
REPO_JSON="$(dirname "$0")/../agi-villa.json"
[ -f "$REPO_JSON" ] || REPO_JSON=/tmp/agi-villa.json

echo "=== AGI-Agenten-Villa Setup $(date -u) ==="
TOKEN="$(sudo grep '^VF_TOKEN=' $DEST/hub.env | cut -d= -f2)"
GTOKEN="$(sudo grep '^GITHUB_TOKEN=' $DEST/hub.env | cut -d= -f2)"
[ -n "$TOKEN" ] && [ -n "$GTOKEN" ] || { echo "FEHLER: hub.env Tokens fehlen"; exit 1; }

# --- Werkzeuge ---
python3 -c 'import venv' 2>/dev/null || sudo apt-get install -y -qq python3-venv python3-full >/dev/null 2>&1 || true
command -v git >/dev/null || sudo apt-get install -y -qq git >/dev/null 2>&1 || true

# --- Repo klonen / aktualisieren ---
mkdir -p "$WS"
if [ ! -d "$REPO/.git" ]; then
  git clone -q "https://x-access-token:${GTOKEN}@github.com/niknight1403/AGI-Agenten.git" "$REPO" || { echo "FEHLER: Clone"; exit 1; }
else
  git -C "$REPO" pull --rebase -q origin main >/dev/null 2>&1 || true
fi
git -C "$REPO" config user.email "villa@villaforge.local"
git -C "$REPO" config user.name "AGI Agenten Villa"

# --- venv + Abhaengigkeiten (enthält pytest) ---
cd "$REPO"
if [ ! -x venv/bin/python ]; then
  python3 -m venv venv || { echo "FEHLER: venv"; exit 1; }
fi
./venv/bin/pip install -q -r agent-loop/requirements.txt 2>&1 | tail -2 || ./venv/bin/pip install -q -r agent-loop/requirements.txt

# --- npm-Brücke für den Sync (villa-sync ruft 'npm test') ---
if [ ! -f package.json ]; then
  printf '{\n  "name": "agi-agenten",\n  "private": true,\n  "scripts": { "test": "./venv/bin/python -m pytest tests/ -q" }\n}\n' > package.json
  git add package.json && git commit -q -m "chore: npm-Bruecke fuer villaforge-sync (npm test -> pytest)" && \
    git push -q origin main && echo "package.json gepusht." || echo "package.json Commit bestaehen nicht (nicht fatal)."
fi

# --- Tests einmalig pruefen ---
./venv/bin/python -m pytest tests/ -q 2>&1 | tail -2 || echo "Hinweis: Tests aktuell nicht komplett gruen."

# --- Villa anlegen (idempotent: nur wenn nicht vorhanden) ---
VFIDS="$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$HUB/api/villas" | python3 -c 'import json,sys; print(" ".join(str(v["id"]) for v in json.load(sys.stdin) if "AGI" in v.get("name","").upper()))' 2>/dev/null || true)"
if [ -n "$VFIDS" ]; then
  echo "Villa existiert bereits: #$VFIDS"
  VILLA_ID="$(echo $VFIDS | awk '{print $1}')"
else
  python3 - "$REPO" "$REPO_JSON" > /tmp/agi-payload.json <<'NEOF'
import json, sys
p = json.load(open(sys.argv[2]))
p['sourcePath'] = sys.argv[1]
json.dump(p, open('/tmp/agi-payload.json', 'w'))
NEOF
  RES="$(curl -s -m 30 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @/tmp/agi-payload.json "$HUB/api/villas")"
  VILLA_ID="$(echo "$RES" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("villaId",""))' 2>/dev/null || true)"
  [ -n "$VILLA_ID" ] || { echo "FEHLER: Villa nicht angelegt: $RES"; exit 1; }
  echo "Villa angelegt: #$VILLA_ID"
fi

# --- In Sync-Config eintragen ---
sudo python3 - "$VILLA_ID" "$REPO" <<'NEOF'
import json, sys
vid, repo = int(sys.argv[1]), sys.argv[2]
p = '/opt/villaforge/villas.json'
try:
    l = json.load(open(p))
except Exception:
    l = []
if not any(v.get('id') == vid for v in l):
    l.append({'id': vid, 'repo': repo, 'testMs': 900000})
json.dump(l, open(p, 'w'), indent=2)
print('villas.json:', json.dumps(l))
NEOF

# --- Villa starten / anstupsen ---
curl -s -m 15 -X POST -H "Authorization: Bearer $TOKEN" "$HUB/api/villas/$VILLA_ID/orchestrate" | head -c 200; echo
echo "=== Fertig. Villa #$VILLA_ID laeuft 24/7 im Zyklen-Takt des Hubs. ==="
