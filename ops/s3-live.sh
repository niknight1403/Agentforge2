set -u
sleep 15
echo "== Health =="
curl -s -m 8 http://127.0.0.1:13000/api/ready | head -c 140; echo
echo "== Restfehler im Journal (letzte 2 Min) =="
journalctl -u cybersarah-ccc --since "-2 min" --no-pager 2>/dev/null | grep -E 'Failed query|does not exist|permission denied' | sed -E 's/^.{0,30}node\[[0-9]+\]: //' | sort | uniq -c | sort -rn | head -4 | cut -c1-260
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
JWT=$(tr '\0' '\n' < /proc/$PID/environ | grep '^JWT_SECRET=' | cut -d= -f2-)
DBU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)
OID=$(sudo -u postgres psql -d cybersarah -At -c "SELECT \"openId\" FROM users WHERE email='niko.oeben@gmail.com' LIMIT 1")
cd /opt/ccc/repo
cat > /tmp/mint.mts <<'TS'
import { sdk } from "/opt/ccc/repo/server/_core/sdk";
console.log(await sdk.createSessionToken(process.env.OID!, { name: "Admin" }));
TS
TOK=$(OID="$OID" JWT_SECRET="$JWT" DATABASE_URL="$DBU" npx --yes tsx /tmp/mint.mts 2>/dev/null | tail -1); rm -f /tmp/mint.mts
H="Authorization: Bearer $TOK"
call() { curl -s -m "$3" -X POST -H "$H" -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:13000/api/trpc/aiInfluenza.$1"; }
echo "== auth.me =="
curl -s -m 10 -H "$H" http://127.0.0.1:13000/api/trpc/auth.me | jq -r '.result.data.json | "role=\(.role) email=\(.email)"' 2>/dev/null
echo "== initialisieren =="; call initialisieren '{"json":{}}' 20 | head -c 300; echo
echo "== Aufgabe anlegen: marktanalyse =="
ANL=$(call aufgabeAnlegen '{"json":{"aufgabeTyp":"marktanalyse","eingabe":{"nische":"KI-Marketing fuer Handwerksbetriebe im DACH-Raum","zielgruppe":"Inhaber mit 5 bis 50 Mitarbeitern"}}}' 20)
echo "$ANL" | head -c 300; echo
AID=$(echo "$ANL" | jq -r '.result.data.json.aufgabeId // .result.data.json.id // empty')
echo "Aufgaben-ID: ${AID:-KEINE}"
if [ -n "${AID:-}" ]; then
  echo "== Aufgabe ausfuehren (echter LLM-Call ueber Hub/Ollama) =="
  call aufgabeAusfuehren "{\"json\":{\"aufgabeId\":$AID}}" 240 -o /tmp/exec.json > /tmp/exec.json
  jq -r '.result.data.json | "Status: \(.status // "?") | Fehler: \(.fehler // "keiner") | Kosten-Cent: \(.kostenCent // "?")"' /tmp/exec.json 2>/dev/null || head -c 300 /tmp/exec.json
  echo "-- Ergebnis (Auszug, 600 Zeichen) --"
  jq -r '.result.data.json.ergebnis // "" | tostring' /tmp/exec.json 2>/dev/null | head -c 600; echo
fi
echo "== DB-Beleg =="
sudo -u postgres psql -d cybersarah -At -c "SELECT 'aufgaben: '||status||' = '||count(*) FROM \"aiAufgaben\" GROUP BY status"
sudo -u postgres psql -d cybersarah -At -c "SELECT 'ereignisse: '||count(*) FROM \"aiAufgabenEreignisse\""
