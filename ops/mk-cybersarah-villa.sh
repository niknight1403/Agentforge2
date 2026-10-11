#!/usr/bin/env bash
# CyberSarah-Villa auf der Oracle-Instanz einrichten (idempotent, resumierbar).
# Laeuft als ubuntu mit sudo. Aufruf via oracle-token.yml (mode: cybervilla).
set -uo pipefail
DEST=/opt/villaforge
WS=$DEST/workspace
REPO=$WS/cybersarah-control-center
HUB="http://127.0.0.1:12000"
GTOKEN="$(sudo grep '^GITHUB_TOKEN=' $DEST/hub.env | cut -d= -f2)"
TOKEN="$(sudo grep '^VF_TOKEN=' $DEST/hub.env | cut -d= -f2)"
STATUS_FILE=/tmp/cybersarah-status.txt

write_status() {
  local MSG="${1:-status}"
  python3 - "$MSG" "$GTOKEN" <<'NEOF' >>"$STATUS_FILE" 2>&1 || true
import base64, json, sys, urllib.request
msg, tok = sys.argv[1], sys.argv[2]
content = open('/tmp/cybersarah-status.txt', 'rb').read() if __import__('os').path.exists('/tmp/cybersarah-status.txt') else b''
body = {'message': f'cybersarah-villa: {msg}', 'content': base64.b64encode(content).decode(), 'branch': 'main'}
try:
    d = json.load(urllib.request.urlopen(urllib.request.Request(
        'https://api.github.com/repos/niknight1403/Agentforge2/contents/CYBERSARAH-VILLA-STATUS.md',
        headers={'Authorization': f'Bearer {tok}'})))
    if 'sha' in d: body['sha'] = d['sha']
except Exception:
    pass
req = urllib.request.Request(
    'https://api.github.com/repos/niknight1403/Agentforge2/contents/CYBERSARAH-VILLA-STATUS.md',
    data=json.dumps(body).encode(), method='PUT',
    headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
try:
    urllib.request.urlopen(req)
    print('Status nach GitHub geschrieben.')
except Exception as e:
    print(f'Status-Upload fehlgeschlagen: {e}')
NEOF
}

trap 'write_status "Setup abgebrochen (Fehler)"' EXIT

echo "=== CyberSarah-Villa Setup $(date -u) ===" | tee "$STATUS_FILE"
[ -n "$TOKEN" ] && [ -n "$GTOKEN" ] || { echo "FEHLER: hub.env Tokens fehlen" | tee -a "$STATUS_FILE"; exit 1; }

# --- Repo klonen / aktualisieren (flacher Klon reicht dem Schwarm) ---
mkdir -p "$WS"
if [ ! -d "$REPO/.git" ]; then
  git clone -q --depth 1 "https://x-access-token:${GTOKEN}@github.com/niknight1403/CyberSarah-Control-Center.git" "$REPO" 2>&1 | tee -a "$STATUS_FILE" || { echo "FEHLER: Clone" | tee -a "$STATUS_FILE"; exit 1; }
else
  git -C "$REPO" fetch -q origin main 2>/dev/null || true
  git -C "$REPO" reset -q --hard origin/main 2>/dev/null || true
fi
echo "Repo bereit: $REPO ($(git -C "$REPO" rev-parse --short HEAD))" | tee -a "$STATUS_FILE"

# --- Villa anlegen (idempotent) ---
VFIDS="$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$HUB/api/villas" | python3 -c 'import json,sys; print(" ".join(str(v["id"]) for v in json.load(sys.stdin) if "CYBERSARAH" in v.get("name","").upper()))' 2>/dev/null || true)"
if [ -n "$VFIDS" ]; then
  VILLA_ID="$(echo $VFIDS | awk '{print $1}')"
  echo "Villa existiert bereits: #$VILLA_ID" | tee -a "$STATUS_FILE"
else
  cp /tmp/cybersarah-villa.json /tmp/cybersarah-payload.json
  python3 - "$REPO" <<'NEOF'
import json, sys
p = json.load(open('/tmp/cybersarah-payload.json'))
p['sourcePath'] = sys.argv[1]
json.dump(p, open('/tmp/cybersarah-payload.json', 'w'))
NEOF
  VILLA_ID=""
  for TRY in 1 2 3 4; do
    RES="$(curl -s -m 90 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @/tmp/cybersarah-payload.json "$HUB/api/villas" 2>&1)"
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
echo "=== FERTIG: CyberSarah-Villa #$VILLA_ID integriert, 24/7 aktiv. ===" | tee -a "$STATUS_FILE"
trap - EXIT
write_status "Setup erfolgreich — CyberSarah-Villa #$VILLA_ID laeuft"
