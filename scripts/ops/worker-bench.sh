#!/usr/bin/env bash
# Misst jeden Ollama-Knoten aus der Routen-Tabelle mit einem echten Lasttest.
# Laeuft auf dem Hub-Server (root), damit die Messung aus Sicht des Hubs gilt.
set -uo pipefail

DB="${VF_DB_PATH:-/opt/villaforge/server/data/villaforge.db}"
PAIRS=$(mktemp)
trap 'rm -f "$PAIRS"' EXIT

python3 - "$DB" >"$PAIRS" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
rows = con.execute(
    "select name, base_url, model from routes where enabled=1 and base_url like '%11434%' order by id"
).fetchall()
for name, base, model in rows:
    print(f"{name}\t{base}\t{model}")
PY

printf '%-38s %-20s %7s %5s %7s %8s\n' "ROUTE" "MODELL" "TAGS" "TOK" "TOK/S" "DAUER"

while IFS=$'\t' read -r name base model; do
  [ -z "${base:-}" ] && continue
  root="${base%/v1}"
  root="${root%/}"

  t0=$(date +%s%N)
  tags=$(curl -s --max-time 6 "$root/api/tags" 2>/dev/null)
  t1=$(date +%s%N)
  tags_ms=$(( (t1 - t0) / 1000000 ))

  if [ -z "$tags" ]; then
    printf '%-38s %-20s %7s %5s %7s %8s\n' "${name:0:36}" "${model:0:20}" "FEHLT" "-" "-" "-"
    continue
  fi

  has_model=$(printf '%s' "$tags" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("?")
    raise SystemExit
names = [m.get("name") for m in data.get("models", [])]
print("ja" if sys.argv[1] in names else "nein")
' "$model")

  body=$(python3 -c '
import json, sys
print(json.dumps({
    "model": sys.argv[1],
    "prompt": "Erklaere in einem Satz, was ein Vektor ist.",
    "stream": False,
    "options": {"num_predict": 32},
}))
' "$model")

  r0=$(date +%s%N)
  resp=$(curl -s --max-time 90 "$root/api/generate" -d "$body" 2>/dev/null)
  r1=$(date +%s%N)
  ms=$(( (r1 - r0) / 1000000 ))

  printf '%s' "${resp:-{}}" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print(f"  antwort=UNLESBAR")
    raise SystemExit
count = data.get("eval_count") or 0
dur = data.get("eval_duration") or 0
tps = round(count / (dur / 1e9), 1) if count and dur else 0
err = data.get("error")
if err:
    print(f"  fehler={str(err)[:40]}")
else:
    print(f"  tok={count} tps={tps}")
' | {
    read -r extra
    printf '%-38s %-20s %6sms %s %8s\n' "${name:0:36}" "${model:0:20}" "$tags_ms" "${has_model:-?}" "$ms"
    echo "      $extra"
  }
done <"$PAIRS"

echo
echo "== lokal geladene Modelle =="
curl -s --max-time 8 http://127.0.0.1:11434/api/ps | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("  keine Daten")
    raise SystemExit
models = data.get("models", [])
if not models:
    print("  keine Modelle geladen")
for m in models:
    print(f"  {m.get(\"name\"):26s} {round(m.get(\"size\", 0) / 1e9, 1)} GB")
'

echo
echo "== Speicher =="
free -m | head -3
