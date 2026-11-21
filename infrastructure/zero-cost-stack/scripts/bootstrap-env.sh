#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ -e .env ]]; then
  echo ".env already exists; refusing to overwrite." >&2
  exit 1
fi
cp .env.example .env
secret() { openssl rand -hex "$1"; }
replace() {
  local key="$1" value="$2"
  sed -i "s|^${key}=.*|${key}=${value}|" .env
}
replace POSTGRES_PASSWORD "$(secret 32)"
replace N8N_DB_PASSWORD "$(secret 32)"
replace N8N_ENCRYPTION_KEY "$(secret 32)"
replace AP_DB_PASSWORD "$(secret 32)"
replace AP_ENCRYPTION_KEY "$(secret 16)"
replace AP_JWT_SECRET "$(secret 48)"
chmod 600 .env
echo "Created protected .env. Review hostnames and URLs before deployment."
