#!/usr/bin/env bash
# Deploy von AnfragePilot auf der Oracle-VM. Wird per scp uebertragen und mit sudo ausgefuehrt.
# Idempotent: mehrfaches Ausfuehren ist unschaedlich.
set -euo pipefail

ZIEL=/opt/anfragepilot
DIENST=anfragepilot.service
PORT=3910
ENV_DATEI="$ZIEL/pilot.env"
RESTART="${RESTART:-true}"

echo "== [1/6] Quellcode entpacken =="
mkdir -p "$ZIEL"
tar -xzf /tmp/pilot.tgz -C "$ZIEL" --overwrite
mkdir -p "$ZIEL/data"
chown -R ubuntu:ubuntu "$ZIEL"
chmod 750 "$ZIEL/data"
echo "Dateien: $(find "$ZIEL" -maxdepth 2 -type f -not -path '*/node_modules/*' | wc -l)"

echo "== [2/6] Abhaengigkeiten installieren =="
cd "$ZIEL"
NPM_LOG="$ZIEL/.deploy-npm.log"
: > "$NPM_LOG"
if ! su - ubuntu -c "cd $ZIEL && npm ci --omit=dev --no-audit --no-fund" >>"$NPM_LOG" 2>&1; then
  echo "npm ci fehlgeschlagen, versuche npm install"
  su - ubuntu -c "cd $ZIEL && npm install --omit=dev --no-audit --no-fund" >>"$NPM_LOG" 2>&1 || { tail -20 "$NPM_LOG"; exit 1; }
fi
echo "Pakete: $(ls node_modules | wc -l)"

echo "== [3/6] Umgebung vorbereiten =="
touch "$ENV_DATEI"
chmod 600 "$ENV_DATEI"
if [ -f /opt/villaforge/hub.env ]; then
  grep -hE '^(export )?(GROQ_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)=' /opt/villaforge/hub.env \
    | sed 's/^export //' > "$ENV_DATEI" || true
fi
grep -qE '^PORT=' "$ENV_DATEI"      || echo "PORT=$PORT" >> "$ENV_DATEI"
grep -qE '^NODE_ENV=' "$ENV_DATEI"  || echo 'NODE_ENV=production' >> "$ENV_DATEI"
grep -qE '^DB_FILE=' "$ENV_DATEI"   || echo "DB_FILE=$ZIEL/data/anfragepilot.db" >> "$ENV_DATEI"
grep -qE '^BASIS_URL=' "$ENV_DATEI" || echo 'BASIS_URL=https://hub.cybersarah-ki.com/pilot' >> "$ENV_DATEI"
chown ubuntu:ubuntu "$ENV_DATEI"
echo "Variablen: $(grep -c '=' "$ENV_DATEI"), Schluessel: $(grep -cE '^(GROQ|OPENAI|GEMINI)_API_KEY=' "$ENV_DATEI" || true)"

echo "== [3b/6] Schreibrecht data/ pruefen =="
echo "Eigentuemer: $(stat -c '%U:%G %a' "$ZIEL/data")"
DB_PROBE="$ZIEL/data/.schreibprobe.db"
if su - ubuntu -c "node -e \"const D=require('$ZIEL/node_modules/better-sqlite3');const d=new D('$DB_PROBE');d.exec('CREATE TABLE probe(a)');d.prepare('INSERT INTO probe VALUES (1)').run();console.log('SQLite-Schreibtest:', d.prepare('SELECT COUNT(*) c FROM probe').get().c === 1 ? 'OK' : 'FEHLER');d.close()\"" 2>&1 | tail -2; then
  rm -f "$DB_PROBE" "$DB_PROBE-shm" "$DB_PROBE-wal"
else
  echo "SQLite kann in $ZIEL/data nicht schreiben - Berechtigungen:"
  ls -ld "$ZIEL/data"; exit 1
fi

echo "== [4/6] systemd-Dienst =="
cat > /etc/systemd/system/$DIENST <<UNIT
[Unit]
Description=AnfragePilot API und Dashboard
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$ZIEL
EnvironmentFile=$ENV_DATEI
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$DIENST" >/dev/null 2>&1 || true
if [ "$RESTART" = "true" ]; then systemctl restart "$DIENST"; fi

STATUS=""
for i in $(seq 1 20); do
  STATUS=$(systemctl is-active "$DIENST" 2>/dev/null || true)
  [ "$STATUS" = "active" ] && { echo "Dienst aktiv nach ${i}s"; break; }
  sleep 1
done
echo "Dienststatus: ${STATUS:-unbekannt}"
if [ "$STATUS" != "active" ]; then
  echo "=== Diagnose: systemctl status ==="
  systemctl status "$DIENST" --no-pager -l | head -25 || true
  echo "=== Diagnose: Journal ==="
  journalctl -u "$DIENST" -n 40 --no-pager | tail -30 || true
  echo "=== Diagnose: Direktstart ==="
  su - ubuntu -c "cd $ZIEL && set -a && . ./pilot.env && set +a && timeout 6 node src/server.js" 2>&1 | head -20 || true
  exit 1
fi

echo "== [5/6] nginx-Unterpfad /pilot/ =="
mkdir -p /etc/nginx/snippets
cat > /etc/nginx/snippets/anfragepilot.conf <<'NGINX'
location /pilot/ {
  proxy_pass http://127.0.0.1:3910/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 120s;
  client_max_body_size 1m;
}
NGINX

SITE=$(grep -rl "server_name hub.cybersarah-ki.com" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -1 || true)
echo "nginx-Site: ${SITE:-nicht gefunden}"
if [ -n "$SITE" ] && ! grep -q "snippets/anfragepilot.conf" "$SITE"; then
  cp "$SITE" "$SITE.bak.$(date +%s)"
  python3 - "$SITE" <<'PY'
import sys
pfad = sys.argv[1]
text = open(pfad).read()
stelle = text.rfind('}')
open(pfad, 'w').write(text[:stelle] + "    include snippets/anfragepilot.conf;\n" + text[stelle:])
PY
  echo "include ergaenzt"
fi
nginx -t
systemctl reload nginx
echo "nginx neu geladen"

echo "== [6/6] Lokale Probe =="
sleep 1
curl -s -m 10 "http://127.0.0.1:$PORT/api/health" && echo "" || echo "lokale Probe fehlgeschlagen"
echo "DEPLOY_OK"
