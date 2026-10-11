#!/usr/bin/env bash
# AGI-Agenten-Villa auf der Oracle-Instanz einrichten (idempotent, resumierbar).
# Laeuft als ubuntu mit sudo. Aufruf via oracle-token.yml (mode: agivilla).
set -uo pipefail
DEST=/opt/villaforge
WS=$DEST/workspace
REPO=$WS/agi-agenten
HUB="http://127.0.0.1:12000"
GTOKEN="$(sudo grep '^GITHUB_TOKEN=' $DEST/hub.env | cut -d= -f2)"
TOKEN="$(sudo grep '^VF_TOKEN=' $DEST/hub.env | cut -d= -f2)"
STATUS_FILE=/tmp/agi-status.txt

write_status() {
  local MSG="${1:-status}"
  python3 - "$MSG" "$GTOKEN" <<'NEOF' >>"$STATUS_FILE" 2>&1 || true
import base64, json, sys, urllib.request
msg, tok = sys.argv[1], sys.argv[2]
content = open('/tmp/agi-status.txt', 'rb').read() if __import__('os').path.exists('/tmp/agi-status.txt') else b''
body = {'message': f'agi-villa: {msg}', 'content': base64.b64encode(content).decode(), 'branch': 'main'}
try:
    d = json.load(urllib.request.urlopen(urllib.request.Request(
        'https://api.github.com/repos/niknight1403/Agentforge2/contents/AGI-VILLA-STATUS.md',
        headers={'Authorization': f'Bearer {tok}'})))
    if 'sha' in d: body['sha'] = d['sha']
except Exception:
    pass
req = urllib.request.Request(
    'https://api.github.com/repos/niknight1403/Agentforge2/contents/AGI-VILLA-STATUS.md',
    data=json.dumps(body).encode(), method='PUT',
    headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
try:
    urllib.request.urlopen(req)
    print('Status nach GitHub geschrieben.')
except Exception as e:
    print('Status-PUT fehlgeschlagen:', e)
NEOF
}
trap 'write_status "Setup-Abbruch/Fehler (siehe Log unten)"' EXIT

echo "=== AGI-Agenten-Villa Setup $(date -u) ===" | tee "$STATUS_FILE"
[ -n "$TOKEN" ] && [ -n "$GTOKEN" ] || { echo "FEHLER: hub.env Tokens fehlen" | tee -a "$STATUS_FILE"; exit 1; }

# --- 0) CPU entlasten: lokale Ollama-Route (Port 11434) auf Prio 40 ---
IDS="$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" "$HUB/api/routes" | python3 -c 'import json,sys; rs=json.load(sys.stdin); print(" ".join(str(r["id"]) for r in rs if "11434" in r.get("base_url","") or "ollama" in r.get("base_url","").lower() or "ollama" in r.get("name","").lower()))' 2>/dev/null || true)"
if [ -n "$IDS" ]; then
  for ID in $IDS; do
    curl -s -m 15 -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"priority": 40}' "$HUB/api/routes/$ID" >/dev/null && echo "Route #$ID (Ollama) auf Prio 40 gestellt." | tee -a "$STATUS_FILE"
  done
else
  echo "Keine Ollama-Route gefunden (oder bereits getuned)." | tee -a "$STATUS_FILE"
fi

# --- Werkzeuge (Sprint-Fix: python3-venv MUSS sitzen, sonst bricht alles spaeter stumm) ---
sudo apt-get update -qq >>"$STATUS_FILE" 2>&1 || true
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
  echo "python3-venv/ensurepip fehlt — Installation (sichtbar im Status):" | tee -a "$STATUS_FILE"
  if ! sudo apt-get install -y -qq python3-venv python3-pip >>"$STATUS_FILE" 2>&1; then
    echo "apt -qq fehlgeschlagen, Wiederholung mit voller Ausgabe:" | tee -a "$STATUS_FILE"
    sudo apt-get install -y python3-venv python3-pip >>"$STATUS_FILE" 2>&1 || true
  fi
  python3 -c "import ensurepip" >/dev/null 2>&1 \
    || echo "WARNUNG: ensurepip weiterhin fehlend — venv-Fallback mit get-pip aktiv." | tee -a "$STATUS_FILE"
fi

# --- Repo klonen / aktualisieren ---
mkdir -p "$WS"
if [ ! -d "$REPO/.git" ]; then
  git clone -q "https://x-access-token:${GTOKEN}@github.com/niknight1403/AGI-Agenten.git" "$REPO" 2>&1 | tee -a "$STATUS_FILE" || { echo "FEHLER: Clone" | tee -a "$STATUS_FILE"; exit 1; }
else
  git -C "$REPO" pull --rebase -q origin main >/dev/null 2>&1 || true
fi
git -C "$REPO" config user.email "villa@villaforge.local"
git -C "$REPO" config user.name "AGI Agenten Villa"

# --- venv + Abhaengigkeiten (requirements enthaelt pytest) ---
cd "$REPO"
if [ ! -x venv/bin/pip ]; then rm -rf venv; fi
if [ ! -x venv/bin/python ]; then
  if ! python3 -m venv venv >>"$STATUS_FILE" 2>&1; then
    echo "venv mit ensurepip fehlgeschlagen — Fallback: --without-pip + get-pip" | tee -a "$STATUS_FILE"
    rm -rf venv
    python3 -m venv --without-pip venv >>"$STATUS_FILE" 2>&1 \
      || { echo "FEHLER: venv" | tee -a "$STATUS_FILE"; exit 1; }
    curl -fsS https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py \
      && ./venv/bin/python /tmp/get-pip.py -q >>"$STATUS_FILE" 2>&1 \
      || echo "WARNUNG: get-pip fehlgeschlagen — pip nicht verfuegbar." | tee -a "$STATUS_FILE"
  fi
fi
if [ -x venv/bin/pip ]; then
  if ! ./venv/bin/pip install -q -r agent-loop/requirements.txt >>"$STATUS_FILE" 2>&1; then
    echo "(pip-Wiederholung mit voller Ausgabe)" | tee -a "$STATUS_FILE"
    ./venv/bin/pip install -r agent-loop/requirements.txt >>"$STATUS_FILE" 2>&1 || true
  fi
else
  echo "FEHLER: pip im venv fehlt — Abhaengigkeiten nicht installierbar." | tee -a "$STATUS_FILE"
fi

# --- npm-Bruecke fuer den Sync (villa-sync ruft 'npm test') ---
if [ ! -f package.json ]; then
  printf '{\n  "name": "agi-agenten",\n  "private": true,\n  "scripts": { "test": "./venv/bin/python -m pytest tests/ -q" }\n}\n' > package.json
  git add package.json && git commit -q -m "chore: npm-Bruecke fuer villaforge-sync (npm test -> pytest)" && git push -q origin main && echo "package.json ins Repo gepusht." | tee -a "$STATUS_FILE"
fi

# --- Tests einmalig pruefen ---
./venv/bin/python -m pytest tests/ -q 2>&1 | tail -3 | tee -a "$STATUS_FILE" || echo "Hinweis: Tests (noch) nicht komplett gruen." | tee -a "$STATUS_FILE"

# --- Villa anlegen (idempotent) ---
VFIDS="$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$HUB/api/villas" | python3 -c 'import json,sys; print(" ".join(str(v["id"]) for v in json.load(sys.stdin) if "AGI" in v.get("name","").upper()))' 2>/dev/null || true)"
if [ -n "$VFIDS" ]; then
  VILLA_ID="$(echo $VFIDS | awk '{print $1}')"
  echo "Villa existiert bereits: #$VILLA_ID" | tee -a "$STATUS_FILE"
else
  cp /tmp/agi-villa.json /tmp/agi-payload.json
  python3 - "$REPO" <<'NEOF'
import json, sys
p = json.load(open('/tmp/agi-payload.json'))
p['sourcePath'] = sys.argv[1]
json.dump(p, open('/tmp/agi-payload.json', 'w'))
NEOF
  VILLA_ID=""
  for TRY in 1 2 3 4; do
    RES="$(curl -s -m 90 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @/tmp/agi-payload.json "$HUB/api/villas" 2>&1)"
    VILLA_ID="$(echo "$RES" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("villaId",""))' 2>/dev/null || true)"
    if [ -n "$VILLA_ID" ]; then echo "Villa angelegt: #$VILLA_ID (Versuch $TRY)" | tee -a "$STATUS_FILE"; break; fi
    echo "POST Versuch $TRY fehlgeschlagen: ${RES:0:200}" | tee -a "$STATUS_FILE"; sleep 20
  done
  [ -n "$VILLA_ID" ] || { echo "FEHLER: Villa nicht angelegt" | tee -a "$STATUS_FILE"; exit 1; }
fi

# --- In Sync-Config eintragen ---
sudo python3 - "$VILLA_ID" "$REPO" <<'NEOF' | tee -a "$STATUS_FILE"
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

# --- Villa anstupsen ---
curl -s -m 15 -X POST -H "Authorization: Bearer $TOKEN" "$HUB/api/villas/$VILLA_ID/orchestrate" | head -c 150 | tee -a "$STATUS_FILE"; echo | tee -a "$STATUS_FILE"
echo "=== FERTIG: Villa #$VILLA_ID integriert, 24/7 aktiv. ===" | tee -a "$STATUS_FILE"
trap - EXIT
write_status "Setup erfolgreich — Villa #$VILLA_ID laeuft"
