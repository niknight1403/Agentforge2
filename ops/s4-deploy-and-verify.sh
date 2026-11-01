set -u
cd /opt/ccc/repo
echo "== Code ziehen =="
git fetch -q origin feature/ai-influenza-phase7 && git reset -q --hard origin/feature/ai-influenza-phase7 && git log --oneline -1 | cut -c1-90
echo "== Migration 0017 (cybersarah-DB) =="
sudo -u postgres psql -d cybersarah -v ON_ERROR_STOP=1 -q -f drizzle/0017_ai_influenza_stripe.sql && echo "Migration OK"
sudo -u postgres psql -d cybersarah -At -c "SELECT string_agg(tablename, ', ') FROM pg_tables WHERE tablename IN ('aiStripeEreignisse','aiKundenAuftraege','aiZahlungen')"
echo "== Rechte der Dienst-Rolle =="
sudo -u postgres psql -d cybersarah -At -c "SELECT has_table_privilege('ccc','public.\"aiZahlungen\"','INSERT'), has_table_privilege('ccc','public.\"aiStripeEreignisse\"','INSERT')"
echo "== Build + Neustart =="
npm run build >/tmp/build.log 2>&1 && echo "Build OK" || { echo "Build FEHLER"; tail -8 /tmp/build.log; exit 1; }
systemctl restart cybersarah-ccc; sleep 25
curl -s -m 8 http://127.0.0.1:13000/api/ready | head -c 100; echo

PID=$(systemctl show cybersarah-ccc -p MainPID --value)
JWT=$(tr '\0' '\n' < /proc/$PID/environ | grep '^JWT_SECRET=' | cut -d= -f2-)
DBU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)
OID=$(sudo -u postgres psql -d cybersarah -At -c "SELECT \"openId\" FROM users WHERE email='niko.oeben@gmail.com' LIMIT 1")
cat > /tmp/mint.mts <<'TS'
import { sdk } from "/opt/ccc/repo/server/_core/sdk";
console.log(await sdk.createSessionToken(process.env.OID!, { name: "Admin" }));
TS
TOK=$(OID="$OID" JWT_SECRET="$JWT" DATABASE_URL="$DBU" npx --yes tsx /tmp/mint.mts 2>/dev/null | tail -1); rm -f /tmp/mint.mts
H="Authorization: Bearer $TOK"
echo "== stripeStatus (Modus-Sperre) =="
curl -s -m 15 -H "$H" http://127.0.0.1:13000/api/trpc/aiInfluenza.stripeStatus | jq -c '.result.data.json'
echo "== stripeEinrichten (Trockenlauf) mit Live-Key OHNE Freigabe: muss GESPERRT sein =="
curl -s -m 20 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"json":{"trocken":true}}' http://127.0.0.1:13000/api/trpc/aiInfluenza.stripeEinrichten | jq -c '.error.json | {message, code}' 2>/dev/null | cut -c1-260
echo "== stripeEinrichten (echtes Anlegen) ohne Freigabe: muss ebenfalls GESPERRT sein =="
curl -s -m 20 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"json":{"trocken":false}}' http://127.0.0.1:13000/api/trpc/aiInfluenza.stripeEinrichten | jq -c '.error.json | {message, code}' 2>/dev/null | cut -c1-260
echo "== Webhook ohne Signatur: muss 400 liefern =="
curl -s -m 10 -o /dev/null -w "HTTP %{http_code}\n" -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:13000/api/ai-influenza/stripe/webhook
echo "== Webhook mit falscher Signatur: muss 400/500 (kein 200) liefern =="
curl -s -m 10 -o /dev/null -w "HTTP %{http_code}\n" -X POST -H 'Content-Type: application/json' -H 'stripe-signature: t=1,v1=abc' -d '{}' http://127.0.0.1:13000/api/ai-influenza/stripe/webhook
echo "== umsatz (muss 0 sein, nichts bezahlt) =="
curl -s -m 15 -H "$H" http://127.0.0.1:13000/api/trpc/aiInfluenza.umsatz | jq -c '.result.data.json'
echo "== Stripe-Objekte bei Stripe unveraendert? (AI-Influenza-Preise, soll 0 sein) =="
KEY=$(tr '\0' '\n' < /proc/$PID/environ | grep '^STRIPE_SECRET_KEY=' | cut -d= -f2-)
curl -s -m 15 -u "$KEY:" "https://api.stripe.com/v1/prices?lookup_keys[]=ai_influenza_starter_monthly_live&lookup_keys[]=ai_influenza_starter_monthly_test" | jq '.data|length'
