#!/usr/bin/env bash
# Exclusive product delivery focus. Requires explicit opt-in and exactly one Deep Villa.
set -euo pipefail
H=${VF_HUB_URL:-https://hub.cybersarah-ki.com}
APPLY=${VF_APPLY:-false}
CURL=(curl --fail-with-body --silent --show-error --max-time 35)
LOGIN=$(jq -n --arg email "${VF_ADMIN_EMAIL:?missing VF_ADMIN_EMAIL}" --arg password "${VF_ADMIN_PASSWORD:?missing VF_ADMIN_PASSWORD}" '{email:$email,password:$password}')
TOKEN=$("${CURL[@]}" -H 'Content-Type: application/json' -d "$LOGIN" "$H/api/auth/login" | jq -er '.token | select(type=="string" and length>0)')
AUTH=("Authorization: Bearer $TOKEN")
VILLAS=$("${CURL[@]}" -H "${AUTH[0]}" "$H/api/villas")
# All decision-making is based on a fresh authenticated inventory, not a guessed ID.
echo 'Read-only Villa inventory for exact target resolution:'
jq -r '.[] | "#\\(.id) \\(.name) [\\(.status)]"' <<< "$VILLAS"
TARGET=$(jq -er '[.[] | select((.name // "" | ascii_downcase | gsub("[ _-]";"")) == "deepvilla")] | if length == 1 then .[0].id else error("Expected exactly one Deep Villa, found "+(length|tostring)) end' <<< "$VILLAS")
jq -c --argjson target "$TARGET" '[.[] | {id,name,status,autonomy,executing,task_count:.tasks_total,done:.tasks_done}] | {target:$target,villas:.}' <<< "$VILLAS"
if [[ "$APPLY" != "true" ]]; then echo "READ-ONLY PREVIEW: no writes"; exit 0; fi
# The focus is installed before disabling competing work so scheduled loops cannot start more.
FOCUS=$(jq -n --argjson id "$TARGET" '{villaIds:[$id], reason:"Deep Villa: exclusive product acceptance until verified completion"}')
"${CURL[@]}" -H "${AUTH[0]}" -H 'Content-Type: application/json' -d "$FOCUS" "$H/api/focus" | jq -e --argjson id "$TARGET" '.ok == true and .villaIds == [$id]' >/dev/null
while IFS= read -r id; do
  [[ "$id" == "$TARGET" ]] && continue
  echo "Pause competing Villa #$id"
  "${CURL[@]}" -X POST -H "${AUTH[0]}" "$H/api/villas/$id/stop" | jq -e '.ok == true' >/dev/null
done < <(jq -r --argjson target "$TARGET" '.[] | select(.id != $target) | select((.autonomy // 0)==1 or (.status // "" | test("^(RUNNING|WAITING_FOR_MODEL|STOPPING)$")) or (.executing // 0)==1) | .id' <<< "$VILLAS")
# Check all competitors are now disarmed, regardless of transient STOPPING state.
AFTER=$("${CURL[@]}" -H "${AUTH[0]}" "$H/api/villas")
jq -e --argjson id "$TARGET" 'all(.[] | select(.id != $id); (.autonomy // 0) == 0)' <<< "$AFTER" >/dev/null
START=$("${CURL[@]}" -H "${AUTH[0]}" -H 'Content-Type: application/json' -d '{"runToCompletion":true,"concurrency":0}' "$H/api/villas/$TARGET/orchestrate")
jq -e '.ok == true' <<< "$START" >/dev/null
echo "Deep Villa #$TARGET is the only autonomous Villa, queued or running."
"${CURL[@]}" -H "${AUTH[0]}" "$H/api/focus" | jq -c '{active,villaIds,open,ready_to_release}'
"${CURL[@]}" -H "${AUTH[0]}" "$H/api/scheduler" | jq -c '{slots,active,queue,retrying}'
