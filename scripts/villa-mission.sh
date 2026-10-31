#!/usr/bin/env bash
# Manual mission entry; scheduled mode observes only. The Hub owns autonomous scheduling.
set -euo pipefail
H=https://hub.cybersarah-ki.com
IDS=${VF_MISSION_IDS:-}
CNAME=${VF_MISSION_NAME:-}
CIDEA=${VF_MISSION_IDEA:-}
CSRC=${VF_MISSION_SOURCE:-}
if [ -n "$IDS" ] && ! [[ "$IDS" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]; then echo 'Ungueltige Villa-IDs.'; exit 2; fi
if [ -n "$CNAME" ] && [ -z "$CIDEA" ]; then echo 'Neue Villa braucht eine explizite Idee.'; exit 2; fi
BODY=$(jq -n --arg email "${VF_ADMIN_EMAIL:?}" --arg password "${VF_ADMIN_PASSWORD:?}" '{email:$email,password:$password}')
TOK=$(curl -fsS -m 30 -H 'Content-Type: application/json' -d "$BODY" "$H/api/auth/login" | jq -er '.token | select(type=="string" and length>0)')
AUTH="Authorization: Bearer $TOK"
if [ -n "$CNAME" ]; then
 BODY=$(jq -n --arg name "$CNAME" --arg idea "$CIDEA" --arg source "$CSRC" '{name:$name,idea:$idea} + (if $source!="" then {sourcePath:$source} else {} end)')
 NID=$(curl -fsS -m 90 -H "$AUTH" -H 'Content-Type: application/json' -d "$BODY" "$H/api/villas" | jq -er '.villaId | select(type=="number" and .>0)')
 IDS="$NID"
fi
if [ -n "$IDS" ]; then
 IFS=',' read -ra selected <<< "$IDS"
 for id in "${selected[@]}"; do
  echo "Expliziter Start: Villa $id"
  curl -fsS -m 60 -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"runToCompletion":true}' "$H/api/villas/$id/orchestrate" | jq -c '{ok,started,queued}'
 done
else
 echo 'Beobachtungsmodus: keine Start-, Retry- oder Autonomie-Aenderungen. Der Hub-Scheduler steuert vorhandene Laeufe.'
fi
curl -fsS -m 30 -H "$AUTH" "$H/api/scheduler" | jq -c '{slots,active,queued,queue}'
curl -fsS -m 30 -H "$AUTH" "$H/api/health" | jq -ce 'select(.ok==true) | {ok,version}'
