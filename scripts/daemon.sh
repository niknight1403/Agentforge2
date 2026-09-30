#!/usr/bin/env bash
# Startet den VillaForge Hub als Hintergrundprozess, damit die Arbeit
# weiterlaeuft, wenn das Terminal geschlossen wird.
#
#   bash scripts/daemon.sh start|stop|status|logs
#
# Der Prozess schreibt nach server/data/hub.log und legt seine PID in
# server/data/hub.pid ab. Unterbrochene Laeufe werden beim Start automatisch
# fortgesetzt (siehe server/resume.mjs).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/server/data"
PID_FILE="$DATA_DIR/hub.pid"
LOG_FILE="$DATA_DIR/hub.log"
PORT="${PORT:-12000}"

mkdir -p "$DATA_DIR"

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  # Ein Zombie (defunct) ist kein laufender Prozess, auch wenn kill -0 noch
  # gelingt. Ohne diese Pruefung haelt das Skript einen toten Hub fuer lebendig.
  if ! kill -0 "$pid" 2>/dev/null; then return 1; fi
  local state
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  case "$state" in
    Z*) return 1 ;;
  esac
  echo "$pid"
}

case "${1:-start}" in
  start)
    if pid="$(running_pid)"; then
      echo "Hub laeuft bereits (PID $pid)."
      exit 0
    fi
    cd "$ROOT" || exit 1
    nohup node server/server.mjs >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    if pid="$(running_pid)"; then
      echo "Hub gestartet (PID $pid) auf Port $PORT."
      echo "Log: $LOG_FILE"
    else
      echo "Start fehlgeschlagen. Letzte Logzeilen:" >&2
      tail -n 20 "$LOG_FILE" >&2
      exit 1
    fi
    ;;
  stop)
    if pid="$(running_pid)"; then
      kill "$pid" 2>/dev/null
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
      rm -f "$PID_FILE"
      echo "Hub gestoppt (PID $pid)."
    else
      echo "Kein laufender Hub gefunden."
      rm -f "$PID_FILE"
    fi
    ;;
  status)
    if pid="$(running_pid)"; then
      echo "Hub laeuft (PID $pid)."
      curl -sS "http://localhost:$PORT/api/health" || true
      echo
    else
      echo "Hub laeuft nicht."
      exit 1
    fi
    ;;
  logs)
    tail -n 50 -f "$LOG_FILE"
    ;;
  *)
    echo "Nutzung: $0 start|stop|status|logs" >&2
    exit 2
    ;;
esac
