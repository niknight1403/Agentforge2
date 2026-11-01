set -u
echo "== lauschende Ports (Node/CCC) =="
ss -ltnp 2>/dev/null | grep -E 'node|:3000|:13000|:12000' | awk '{print $4, $6}' | cut -c1-90
echo "== Unit: Port, ExecStart, Env-Namen =="
systemctl show cybersarah-ccc -p Environment --value | tr ' ' '\n' | grep -E '^(PORT|NODE_ENV)=' 
systemctl show cybersarah-ccc -p ExecStart --value | cut -c1-160
echo "== wer antwortet auf welchem Port? (health) =="
for P in 3000 12000 13000; do printf "%s -> " "$P"; curl -s -m 5 "http://127.0.0.1:$P/api/health" | head -c 120; echo; done
echo "== tRPC-Pfad pruefen: auth.me auf 13000 mit Bearer =="
JWT_SECRET=$(systemctl show cybersarah-ccc -p Environment --value | tr ' ' '\n' | grep '^JWT_SECRET=' | cut -d= -f2-)
OID=$(sudo -u postgres psql -d cybersarah -At -c "SELECT \"openId\" FROM users WHERE email='niko.oeben@gmail.com' LIMIT 1")
cd /opt/ccc/repo
cat > /tmp/probe.mts <<'TS'
import { sdk } from "/opt/ccc/repo/server/_core/sdk";
console.log(await sdk.createSessionToken(process.env.OID!, { name: "probe" }));
TS
TOK=$(OID="$OID" JWT_SECRET="$JWT_SECRET" npx --yes tsx /tmp/probe.mts 2>/dev/null | tail -1)
echo "Token-Laenge: ${#TOK}"
echo "-- auth.me (Bearer, Port 13000) --"
curl -s -m 15 -H "Authorization: Bearer $TOK" "http://127.0.0.1:13000/api/trpc/auth.me" | head -c 260; echo
echo "-- uebersicht (Bearer, Port 13000) --"
curl -s -m 15 -H "Authorization: Bearer $TOK" "http://127.0.0.1:13000/api/trpc/aiInfluenza.uebersicht" | head -c 260; echo
rm -f /tmp/probe.mts
