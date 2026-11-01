#!/usr/bin/env bash
# Diagnose der nginx-Topologie fuer den Unterpfad /pilot/ (nur lesend).
set -uo pipefail

echo "===== 1) sites-enabled ====="
ls -l /etc/nginx/sites-enabled/ 2>/dev/null

echo ""
echo "===== 2) Serverbloecke mit hub.cybersarah-ki.com (welche Datei?) ====="
grep -rn "server_name hub.cybersarah-ki.com" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null

echo ""
echo "===== 3) Wer lauscht auf 443? ====="
grep -rn "listen .*443\|listen 443" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -20

echo ""
echo "===== 4) Ist unser location im GELADENEN Konfigurationsbaum? ====="
nginx -T 2>/dev/null | grep -n "location /pilot/" | head -5
echo "Treffer: $(nginx -T 2>/dev/null | grep -c 'location /pilot/')"

echo ""
echo "===== 5) Kontext um unsere Location im geladenen Baum ====="
nginx -T 2>/dev/null | grep -n "location /pilot/" | head -1 | cut -d: -f1 | while read -r ZEILE; do
  [ -n "$ZEILE" ] && nginx -T 2>/dev/null | sed -n "$((ZEILE-25)),$((ZEILE+12))p"
done

echo ""
echo "===== 6) Vorhandene location-Bloecke der Hub-Site ====="
nginx -T 2>/dev/null | grep -nE "^\s*location" | head -25

echo ""
echo "===== 7) Direktproben ====="
echo -n "127.0.0.1:9443 /pilot/api/health  -> "; curl -sk -o /dev/null -m 8 -w "%{http_code}\n" -H "Host: hub.cybersarah-ki.com" https://127.0.0.1:9443/pilot/api/health
echo -n "127.0.0.1:9443 /ccc/api/health    -> "; curl -sk -o /dev/null -m 8 -w "%{http_code}\n" -H "Host: hub.cybersarah-ki.com" https://127.0.0.1:9443/ccc/api/health
echo -n "127.0.0.1:9443 /api/health        -> "; curl -sk -o /dev/null -m 8 -w "%{http_code}\n" -H "Host: hub.cybersarah-ki.com" https://127.0.0.1:9443/api/health
echo -n "127.0.0.1:443  /pilot/api/health  -> "; curl -sk -o /dev/null -m 8 -w "%{http_code}\n" -H "Host: hub.cybersarah-ki.com" https://127.0.0.1/pilot/api/health
echo -n "Pilot-Dienst direkt :3910         -> "; curl -s -o /dev/null -m 8 -w "%{http_code}\n" http://127.0.0.1:3910/api/health

echo ""
echo "===== 8) Laeuft ein zweiter Webserver (Caddy/Traefik) auf 443? ====="
ss -tlnp 2>/dev/null | grep -E ":443 |:80 |:9443 " | head -10

echo ""
echo "===== 9) Logfile ====="
ls -l /var/log/anfragepilot/ 2>/dev/null
echo "--- letzte Zeilen app.log ---"
tail -5 /var/log/anfragepilot/app.log 2>/dev/null || echo "app.log fehlt"
echo -n "Schreibtest als ubuntu: "
su - ubuntu -c "echo 'schreibtest $(date -Is)' >> /var/log/anfragepilot/app.log" 2>&1 && echo "OK" || echo "FEHLGESCHLAGEN"
echo "--- Zeilenanzahl danach: $(wc -l < /var/log/anfragepilot/app.log 2>/dev/null) ---"

echo "DIAGNOSE_ENDE"
