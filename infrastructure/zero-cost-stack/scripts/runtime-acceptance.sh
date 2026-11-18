#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only runtime acceptance checks for the local stack.
# Run after: docker compose up -d and the documented model pull.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
PASS_COUNT=0
FAIL_COUNT=0
MODEL="${OLLAMA_ACCEPTANCE_MODEL:-qwen2.5-coder:7b}"

pass() { printf 'PASS  %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED=1; }

command -v docker >/dev/null 2>&1 || { echo "docker CLI is required" >&2; exit 2; }
docker compose config --quiet || { echo "Compose configuration is invalid" >&2; exit 2; }

for service in postgres redis ollama n8n activepieces languagetool; do
  if docker compose ps --status running --services | grep -Fxq "$service"; then
    pass "$service container running"
  else
    fail "$service container running"
  fi
done

if docker compose exec -T postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
  pass "PostgreSQL accepts connections"
else
  fail "PostgreSQL accepts connections"
fi

for db_var in N8N_DB_NAME AP_DB_NAME; do
  db_name="$(grep -E "^(${db_var}=|# ${db_var}=)" .env | tail -n1 | cut -d= -f2- | tr -d '"')"
  case "$db_var" in
    N8N_DB_NAME) db_name="${db_name:-n8n}" ;;
    AP_DB_NAME) db_name="${db_name:-activepieces}" ;;
  esac
  if [[ -n "$db_name" ]] && docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_database WHERE datname = '\'''"$db_name"'''\''" | grep -q 1' >/dev/null 2>&1; then
    pass "database $db_name exists"
  else
    fail "database $db_name exists (init scripts only run on an empty volume)"
  fi
done

if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
  pass "Redis responds to PING"
else
  fail "Redis responds to PING"
fi

if curl --fail --silent http://127.0.0.1:11434/api/tags | jq -e --arg model "$MODEL" '.models | any(.name == $model or (.name | startswith($model + ":")))' >/dev/null; then
  pass "Ollama model available: $MODEL"
else
  fail "Ollama model available: $MODEL (pull it with docker compose exec ollama ollama pull $MODEL)"
fi

if curl --fail --silent http://127.0.0.1:5678/healthz >/dev/null; then
  pass "n8n health endpoint"
else
  fail "n8n health endpoint"
fi

if curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080 | grep -Eq '^(200|301|302|401|403)$'; then
  pass "Activepieces HTTP endpoint responds"
else
  fail "Activepieces HTTP endpoint responds"
fi

if curl --fail --silent http://127.0.0.1:8010/v2/languages | jq -e 'type == "array" and length > 0' >/dev/null; then
  pass "LanguageTool languages API"
else
  fail "LanguageTool languages API"
fi

printf '\nRuntime acceptance: %s passed, %s failed.\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAILED" -ne 0 ]]; then
  echo "This is not a production approval. Inspect: docker compose ps && docker compose logs --tail=100"
  exit 1
fi
echo "All read-only runtime checks passed. Workflow authentication and end-to-end task execution still require separate verification."
