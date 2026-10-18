#!/bin/bash
# ============================================================================
# install-resilience.sh — idempotente Installation des Resilienz-Pakets
# ============================================================================
# Setzt auf der Oracle-Free-Tier-Instanz (ARM, 24 GB) ein:
#   1. systemd-Drop-Ins: unendliche Neustarts, GC-Tuning, RAM-Deckel
#   2. Watchdog-Skript  : Cron alle 2 Minuten, Selbstheilung, rotierende Logs
#   3. Logrotate-Konfiguration fuer /var/log/villaforge
# Mehrfacher Aufruf ist gefahrlos (alles ueberschreibt sich sauber selbst).
# ============================================================================
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"   # /opt/villaforge/server

echo "== 1/4 systemd-Drop-Ins installieren =="
install_dropin() {
  local unit="$1" file="$2" name="$3"
  local dir="/etc/systemd/system/${unit}.service.d"
  mkdir -p "$dir"
  cp "$SRC/deploy/$file" "$dir/$name.conf"
  echo "  $unit <- $name.conf"
}
install_dropin villaforge-hub villaforge-hub-resilience.conf resilience
install_dropin ollama         ollama-resilience.conf         resilience
install_dropin nginx          nginx-resilience.conf          resilience
systemctl daemon-reload
echo "  daemon-reload OK"

echo "== 2/4 Watchdog + Cron installieren =="
mkdir -p /var/log/villaforge /var/lib/villaforge
chmod 0755 "$SRC/scripts/villa-watchdog.sh"
# Skript liegt bereits am Zielort (Repo-Layout = Installations-Layout)
install -m 0644 "$SRC/deploy/cron-villa-watchdog" /etc/cron.d/villa-watchdog
echo "  /etc/cron.d/villa-watchdog aktiv (alle 2 Minuten)"

echo "== 3/4 Logrotate installieren =="
install -m 0644 "$SRC/deploy/logrotate-villaforge" /etc/logrotate.d/villaforge
echo "  /etc/logrotate.d/villaforge aktiv (woechentlich, 4 Rotationen)"

echo "== 4/4 Dienste mit neuer Konfiguration starten =="
systemctl restart villaforge-hub
systemctl restart ollama
systemctl restart nginx

sleep 6
echo "== Verifikation =="
for s in villaforge-hub ollama nginx; do
  echo "  $s: $(systemctl is-active $s)"
done
echo "  Hub-Health: $(curl -fsS -m 8 http://127.0.0.1:12000/api/health | head -c 200)"
echo ""
echo "Resilienz-Paket installiert — System ist selbstheilend."
