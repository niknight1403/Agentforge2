#!/bin/bash
# ============================================================================
# VillaForge Watchdog — autonome Selbstheilung (Cron alle 2 Minuten)
# ============================================================================
# Prueft die lokalen Kern-Dienste und die TLS-Frontdoor. Nach zwei
# aufeinanderfolgenden Fehlern wird der betroffene Dienst bereinigt und
# neu gestartet. Alle Aktionen landen in rotierenden Log-Dateien.
#
# Geschaetzte Dienste:
#   hub     : http://127.0.0.1:12000/api/health  (villaforge-hub)
#   ollama  : http://127.0.0.1:11434/api/tags    (ollama)
#   nginx   : systemctl is-active nginx
#   tls     : https://hub.cybersarah-ki.com/api/health (volle Kette inkl. TLS)
# ============================================================================
set -u

LOG_DIR="/var/log/villaforge"
LOG="$LOG_DIR/watchdog.log"
STATE_DIR="/var/lib/villaforge"
STATE="$STATE_DIR/watchdog.state"
LOCK="$STATE_DIR/watchdog.lock"
THRESHOLD=2          # Fehlversuche bis zum Neustart

mkdir -p "$LOG_DIR" "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0 # kein paralleler Lauf

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; logger -t villa-watchdog -- "$*" 2>/dev/null || true; }

# Zaehlerstand laden: name=misses
declare -A MISSES
if [ -f "$STATE" ]; then
  while IFS='=' read -r k v; do [ -n "$k" ] && MISSES[$k]=$v; done < "$STATE"
fi
save_state() {
  : > "$STATE"
  for k in hub ollama nginx tls; do echo "$k=${MISSES[$k]:-0}" >> "$STATE"; done
}

# check <name> <testkommando...>  ; restart_svc <unit>
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    if [ "${MISSES[$name]:-0}" -gt 0 ]; then log "OK  $name wieder erreichbar"; fi
    MISSES[$name]=0
  else
    MISSES[$name]=$(( ${MISSES[$name]:-0} + 1 ))
    log "WARN $name nicht erreichbar (Versuch ${MISSES[$name]}/$THRESHOLD)"
  fi
}

restart_svc() {
  local name="$1" unit="$2"
  log "ACT  $name: Neustart von $unit"
  systemctl restart "$unit" >> "$LOG" 2>&1 || true
  MISSES[$name]=0
}

check hub    curl -fsS -m 8 http://127.0.0.1:12000/api/health
check ollama curl -fsS -m 8 http://127.0.0.1:11434/api/tags
check nginx  test "$(systemctl is-active nginx 2>/dev/null)" = "active"
check tls    curl -fsS -m 12 https://hub.cybersarah-ki.com/api/health

# --- Selbstheilung nach Schwellwert ---
[ "${MISSES[hub]:-0}"    -ge "$THRESHOLD" ] && restart_svc hub    villaforge-hub
[ "${MISSES[ollama]:-0}" -ge "$THRESHOLD" ] && restart_svc ollama ollama
[ "${MISSES[nginx]:-0}"  -ge "$THRESHOLD" ] && restart_svc nginx  nginx
# TLS-Fehler bei intern intaktem Nginx deutet auf hängende Worker hin
if [ "${MISSES[tls]:-0}" -ge "$THRESHOLD" ] && [ "${MISSES[nginx]:-0}" -lt "$THRESHOLD" ]; then
  log "ACT  tls: Frontdoor-Fehler trotz aktivem Nginx — Reload"
  systemctl reload nginx >> "$LOG" 2>&1 || systemctl restart nginx >> "$LOG" 2>&1 || true
  MISSES[tls]=0
fi

save_state

# Vergroesserungsschutz: Log auf 5 MB begrenzen (zusaetzlich zu logrotate)
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 2097152 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG" || rm -f "$LOG.tmp"
fi

exit 0
