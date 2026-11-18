#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAILED=0
check() {
  local name="$1"; shift
  printf '%-18s' "$name"
  if "$@" >/dev/null 2>&1; then echo "PASS"; else echo "FAIL"; FAILED=1; fi
}
check compose-config docker compose config --quiet
check postgres docker compose exec -T postgres pg_isready
check redis docker compose exec -T redis redis-cli ping
check ollama curl --fail --silent http://localhost:11434/api/tags
check languagetool curl --fail --silent http://localhost:8010/v2/languages
check n8n curl --fail --silent http://localhost:5678/healthz
if [[ "$FAILED" -ne 0 ]]; then
  echo
  docker compose ps
  docker compose logs --tail=100
  exit 1
fi
echo "All configured checks passed. Activepieces needs its authenticated setup/API check."
