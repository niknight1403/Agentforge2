#!/usr/bin/env bash
# CCC-VM-Stack: Postgres + CCC-Server + nginx auf der Oracle-VM. Idempotent.
set -euo pipefail
source /tmp/ccc.env

CCC_DIR=/opt/ccc
sudo mkdir -p "$CCC_DIR"
sudo chown ubuntu:ubuntu "$CCC_DIR"

echo "== [1/7] Postgres installieren (falls fehlt) =="
if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update -qq
  DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq postgresql postgresql-contrib
fi
sudo systemctl enable --now postgresql

echo "== [2/7] Rolle + Datenbank anlegen (idempotent) =="
if [ ! -f "$CCC_DIR/.dbpass" ]; then
  openssl rand -hex 16 > "$CCC_DIR/.dbpass.tmp"
  chmod 600 "$CCC_DIR/.dbpass.tmp"
  mv "$CCC_DIR/.dbpass.tmp" "$CCC_DIR/.dbpass"
fi
DBPASS=$(cat "$CCC_DIR/.dbpass")
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='ccc'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE ccc LOGIN PASSWORD '$DBPASS';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='cybersarah'" | grep -q 1 || \
  sudo -u postgres createdb -O ccc cybersarah
echo "DB bereit."

echo "== [3/7] CCC-Repo klonen/aktualisieren =="
if [ ! -d "$CCC_DIR/repo/.git" ]; then
  git clone -q "https://x-access-token:${CCC_TOKEN}@github.com/niknight1403/CyberSarah-Control-Center.git" "$CCC_DIR/repo"
else
  (cd "$CCC_DIR/repo" && git remote set-url origin "https://x-access-token:${CCC_TOKEN}@github.com/niknight1403/CyberSarah-Control-Center.git")
fi
cd "$CCC_DIR/repo"
git fetch -q origin
git reset -q --hard origin/main
echo "Stand: $(git log -1 --oneline)"

echo "== [4/7] Abhaengigkeiten + Server-Build =="
npm ci --no-audit --no-fund
npm run build
echo "Server gebaut (dist/)."

echo "== [5/7] Drizzle-Migrationen =="
DATABASE_URL="postgresql://ccc:${DBPASS}@127.0.0.1:5432/cybersarah" npx drizzle-kit migrate
echo "Schema aktuell."

echo "== [6/7] systemd-Unit =="
if [ ! -f "$CCC_DIR/.jwt" ]; then
  openssl rand -hex 32 > "$CCC_DIR/.jwt.tmp"
  chmod 600 "$CCC_DIR/.jwt.tmp"
  mv "$CCC_DIR/.jwt.tmp" "$CCC_DIR/.jwt"
fi
JWT=$(cat "$CCC_DIR/.jwt")
if [ ! -f "$CCC_DIR/.ipnpass" ]; then
  openssl rand -hex 16 > "$CCC_DIR/.ipnpass.tmp"
  chmod 600 "$CCC_DIR/.ipnpass.tmp"
  mv "$CCC_DIR/.ipnpass.tmp" "$CCC_DIR/.ipnpass"
fi
IPNPASS=$(cat "$CCC_DIR/.ipnpass")
STRIPE_ENV=""
if [ -n "${STRIPE_KEY}" ]; then
  STRIPE_ENV="Environment=STRIPE_SECRET_KEY=${STRIPE_KEY}"
fi
if [ -n "${STRIPE_WHSEC:-}" ]; then
  STRIPE_ENV="${STRIPE_ENV}
Environment=STRIPE_WEBHOOK_SECRET=${STRIPE_WHSEC}"
fi
OR_ENV=""
if [ -n "${OPENROUTER_KEY}" ]; then
  OR_ENV="Environment=OPENROUTER_API_KEY=${OPENROUTER_KEY}"
fi
sudo tee /etc/systemd/system/cybersarah-ccc.service >/dev/null <<UNIT
[Unit]
Description=CyberSarah Control Center API (Postgres auf VM, Port 13000)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${CCC_DIR}/repo
Environment=NODE_ENV=production
Environment=PORT=13000
Environment=DATABASE_URL=postgresql://ccc:${DBPASS}@127.0.0.1:5432/cybersarah
Environment=JWT_SECRET=${JWT}
Environment=ADMIN_EMAIL=niko.oeben@gmail.com
Environment=APP_BASE_URL=https://hub.cybersarah-ki.com/ccc
Environment=GOOGLE_WEB_CLIENT_ID=656137332727-2i47bqt2fk359nj48tc0kdfl3mhjmoo1.apps.googleusercontent.com
Environment=DIGISTORE24_IPN_PASSPHRASE=${IPNPASS}
Environment=LANDING_PUBLIC_BASE=https://hub.cybersarah-ki.com/ccc
Environment=APP_ALLOWED_ORIGINS=https://app.cybersarah-ki.com,https://hub.cybersarah-ki.com,capacitor://localhost,https://localhost,exp://localhost,http://localhost
${STRIPE_ENV}
${OR_ENV}
ExecStart=$(which node) dist/index.js
Restart=always
RestartSec=5
User=ubuntu

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable cybersarah-ccc
sudo systemctl restart cybersarah-ccc
sleep 4
if curl -sf http://127.0.0.1:13000/api/health >/dev/null; then
  echo "Lokale Health OK."
else
  echo "Lokale Health FEHLGESCHLAGEN - letzte Logs:"
  sudo journalctl -u cybersarah-ccc -n 30 --no-pager || true
  exit 1
fi

echo "== [7/7] nginx-Route /ccc/ (443, bestehender Host) =="
sudo python3 /tmp/ccc-nginx-route.py
sudo nginx -t
sudo systemctl reload nginx

echo "== Externe Verifikation =="
sleep 2
curl -sf https://hub.cybersarah-ki.com/ccc/api/health || { echo "Externe Health FEHLGESCHLAGEN"; exit 1; }
echo ""
echo "== [7/7] DIAGNOSE =="
echo "Deploy-Commit: $(git -C $CCC_DIR/repo log -1 --oneline)"
echo "dist/index.js: $(ls -la $CCC_DIR/repo/dist/index.js 2>&1 | awk '{print $6, $7, $8}')"
echo "Route im Quellcode: $(grep -c 'webhooks/digistore24' $CCC_DIR/repo/server/_core/index.ts) Treffer"
sudo systemctl show cybersarah-ccc -p ActiveEnterTimestamp -p MainPID
echo "Lokaler Webhook-Test:"; curl -s -o /dev/null -w "  HTTP %{http_code}\n" -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:13000/api/v1/webhooks/digistore24
echo "Lokaler Google-Config-Test:"; curl -s http://127.0.0.1:13000/api/trpc/account.googleLoginConfig | head -c 130; echo
echo "Port-Belegung 13000: $(sudo ss -tlnp | grep 13000 | head -1)"
echo "IPN-PASSPHRASE (fuer Digistore24 eintragen): $IPNPASS"
echo "CCC-VM-STACK OK"
