#!/usr/bin/env bash
set -Eeuo pipefail

: "${N8N_DB_NAME:?N8N_DB_NAME is required}"
: "${N8N_DB_USER:?N8N_DB_USER is required}"
: "${N8N_DB_PASSWORD:?N8N_DB_PASSWORD is required}"
: "${AP_DB_NAME:?AP_DB_NAME is required}"
: "${AP_DB_USER:?AP_DB_USER is required}"
: "${AP_DB_PASSWORD:?AP_DB_PASSWORD is required}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=n8n_db="$N8N_DB_NAME" \
  --set=n8n_user="$N8N_DB_USER" \
  --set=n8n_password="$N8N_DB_PASSWORD" \
  --set=ap_db="$AP_DB_NAME" \
  --set=ap_user="$AP_DB_USER" \
  --set=ap_password="$AP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'n8n_user', :'n8n_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'n8n_user')\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'n8n_db', :'n8n_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'n8n_db')\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'ap_user', :'ap_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'ap_user')\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'ap_db', :'ap_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'ap_db')\gexec
SQL
