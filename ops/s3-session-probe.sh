set -u
cd /opt/ccc/repo
PORT=$(systemctl show cybersarah-ccc -p Environment --value | tr ' ' '\n' | grep '^PORT=' | cut -d= -f2); PORT=${PORT:-3000}
# Secrets nur in Prozess-Variablen, nie ausgeben
export JWT_SECRET=$(systemctl show cybersarah-ccc -p Environment --value | tr ' ' '\n' | grep '^JWT_SECRET=' | cut -d= -f2-)
OID=$(sudo -u postgres psql -d cybersarah -At -c "SELECT \"openId\" FROM users WHERE email='niko.oeben@gmail.com' LIMIT 1")
echo "openId-Laenge: ${#OID} | Secret-Laenge: ${#JWT_SECRET} | PORT: $PORT"
echo "== Server-Code: getSessionSecret / COOKIE_NAME =="
grep -n "getSessionSecret" -B1 -A4 server/_core/sdk.ts | sed -n '1,12p'
grep -rn "COOKIE_NAME =" shared/const.ts
echo "== Session mit Server-Code minten =="
cat > /tmp/probe.mts <<'TS'
import { sdk } from "/opt/ccc/repo/server/_core/sdk";
const t = await sdk.createSessionToken(process.env.OID!, { name: "probe" });
console.log(t);
TS
TOK=$(OID="$OID" npx --yes tsx /tmp/probe.mts 2>/tmp/probe.err | tail -1)
echo "Token-Laenge: ${#TOK} (Fehler: $(head -c 200 /tmp/probe.err))"
for MODE in cookie bearer; do
  if [ "$MODE" = cookie ]; then H="Cookie: app_session_id=$TOK"; else H="Authorization: Bearer $TOK"; fi
  echo "-- $MODE: auth.me --"
  curl -s -m 15 -H "$H" "http://127.0.0.1:$PORT/api/trpc/auth.me" | head -c 220; echo
  echo "-- $MODE: aiInfluenza.uebersicht --"
  curl -s -m 15 -H "$H" "http://127.0.0.1:$PORT/api/trpc/aiInfluenza.uebersicht" | head -c 220; echo
done
rm -f /tmp/probe.mts /tmp/probe.err
