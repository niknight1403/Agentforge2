#!/usr/bin/env bash
# Loop-Guard — autonomer Stabilitaets-Waechter fuer die Oracle-VM
# Erkennt und behebt: Log-Stuerme, Restart-Schleifen, volle Platte, tote Kern-Dienste.
# Cooldown: max. 1 Aktion pro Einheit pro Stunde (verhindert Guard-eigene Schleifen).
set -uo pipefail

STATE_DIR=/var/lib/loop-guard
LOG=/var/log/loop-guard.log
WATCH_UNITS="villaforge-hub cybersarah-ccc ollama nginx postgresql@16-main"
mkdir -p "$STATE_DIR"
ACTIONS=""
FAILED=0
now=$(date +%s)

mark() { ACTIONS="$ACTIONS $1"; }
cooldown_ok() {
  local unit="$1" f="$STATE_DIR/$unit.last" t=0
  [ -f "$f" ] && t=$(cat "$f")
  [ $((now - t)) -ge 3600 ]
}
act() {
  local unit="$1"
  if cooldown_ok "$unit"; then
    echo "$now" > "$STATE_DIR/$unit.last"
    systemctl restart "$unit" 2>/dev/null && mark "RESTART:$unit" || mark "RESTART_FEHL:$unit"
  else
    mark "COOLDOWN:$unit"
  fi
}

# --- 1) Syslog-Sturm erkennen (10s Stichprobe) ---
S1=$(stat -c %s /var/log/syslog 2>/dev/null || echo 0)
sleep 10
S2=$(stat -c %s /var/log/syslog 2>/dev/null || echo 0)
RATE=$(( (S2 - S1) / 10 ))
if [ "$RATE" -gt 300000 ]; then
  TOP=$(tail -c 300000 /var/log/syslog 2>/dev/null | grep -oE '[A-Za-z0-9._-]+\[[0-9]+\]' | sort | uniq -c | sort -rn | head -1)
  mark "LOGSTURM:${RATE}B/s($TOP)"
  TOPPID=$(printf "%s" "$TOP" | grep -oE '[0-9]+$')
  if [ -n "${TOPPID:-}" ]; then
    OWNER=$(systemctl status "$TOPPID" 2>/dev/null | head -1 | grep -oE '[A-Za-z0-9@._-]+\.(service|scope)' | head -1 | sed 's/\.scope$//')
    case " $OWNER " in *" villaforge-hub "*|*" cybersarah-ccc "*) act "$OWNER";; esac
  fi
fi

# --- 2) Gescheiterte Einheiten ---
while read -r u; do
  [ -z "$u" ] && continue
  case "$u" in villaforge-hub.service|cybersarah-ccc.service|ollama.service|nginx.service) act "${u%.service}";; esac
done < <(systemctl list-units --state=failed --no-legend 2>/dev/null | awk '{print $1}')

# --- 3) Restart-Schleifen (NRestarts) ---
for u in $WATCH_UNITS; do
  NR=$(systemctl show "$u" -p NRestarts --value 2>/dev/null || echo 0)
  if [ "${NR:-0}" -gt 20 ]; then
    act "$u"
    systemctl reset-failed "$u" 2>/dev/null || true
    mark "LOOP:$u(NRestarts=$NR)"
  fi
done

# --- 4) Platten-Wache ---
USE=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
if [ "${USE:-0}" -gt 88 ]; then
  journalctl --vacuum-size=400M >/dev/null 2>&1 || true
  SZ=$(stat -c %s /var/log/syslog 2>/dev/null || echo 0)
  [ "$SZ" -gt 500000000 ] && truncate -s 0 /var/log/syslog && mark "SYSLOG_TRUNC"
  [ "${USE:-0}" -gt 95 ] && mark "KRITISCHE_PLATTE:${USE}%"
  mark "DISK_CLEAN:${USE}%"
fi

# --- 5) Kern-Dienste live pruefen ---
if ! sudo -u postgres pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
  act "postgresql@16-main"; pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null || { mark "PG_TOT"; FAILED=1; }
fi
if ! curl -fs -m 8 http://127.0.0.1:12000/api/health >/dev/null 2>&1; then
  act "villaforge-hub"; sleep 5
  curl -fs -m 8 http://127.0.0.1:12000/api/health >/dev/null 2>&1 || { mark "HUB_TOT"; FAILED=1; }
fi
if ! curl -fs -m 8 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  act "ollama"; sleep 5
  curl -fs -m 8 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 || { mark "OLLAMA_TOT"; FAILED=1; }
fi
systemctl is-active --quiet nginx || act "nginx"
systemctl is-active --quiet revenue-bridge-relay 2>/dev/null || mark "RELAY_INAKTIV"

# --- 6) Guard-Log (max 5 MB) ---
GSZ=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
[ "$GSZ" -gt 5000000 ] && truncate -s 0 "$LOG"
echo "$(date -u +%FT%TZ) disk=${USE}% rate=${RATE}B/s actions=[$ACTIONS]" >> "$LOG"

# --- 7) Zusammenfassung ---
echo "LOOP-GUARD: disk=${USE}% syslog=${RATE}B/s"
echo "Aktionen: ${ACTIONS:-keine}"
[ "$FAILED" -eq 1 ] && { echo "ESCALATION: Kern-Dienst trotz Heilung down"; exit 2; }
exit 0
