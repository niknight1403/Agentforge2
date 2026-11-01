set -u
cd /opt/ccc/repo
git fetch -q origin feature/ai-influenza-phase7 && git reset -q --hard origin/feature/ai-influenza-phase7 && git log --oneline -1 | cut -c1-80

echo "== 1) Test-Secrets in die Dienst-Umgebung (Drop-in, chmod 600, nur Test-Modus) =="
case "$STRIPE_TEST_KEY" in sk_test_*) ;; *) echo "ABBRUCH: kein sk_test_-Key"; exit 1;; esac
install -d -m 755 /etc/systemd/system/cybersarah-ccc.service.d
umask 077
cat > /etc/systemd/system/cybersarah-ccc.service.d/ai-influenza-stripe.conf <<EOF
[Service]
Environment="AI_INFLUENZA_STRIPE_SECRET_KEY=$STRIPE_TEST_KEY"
Environment="AI_INFLUENZA_STRIPE_WEBHOOK_SECRET=$STRIPE_TEST_WHSEC"
EOF
chmod 600 /etc/systemd/system/cybersarah-ccc.service.d/ai-influenza-stripe.conf
umask 022
npm run build >/tmp/build.log 2>&1 && echo "Build OK" || { tail -6 /tmp/build.log; exit 1; }
systemctl daemon-reload && systemctl restart cybersarah-ccc; sleep 25

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
T() { curl -s -m 40 -X POST -H "$H" -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:13000/api/trpc/aiInfluenza.$1"; }

echo "== 2) stripeStatus =="
curl -s -m 15 -H "$H" http://127.0.0.1:13000/api/trpc/aiInfluenza.stripeStatus | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['data']['json'])"
echo "== 3) Stripe-Objekte einrichten (Trockenlauf, sollen vorhanden sein) =="
T stripeEinrichten '{"json":{"trocken":true}}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{}).get('data',{}).get('json')
print([(o['paket'],o['aktion']) for o in r['objekte']] if r else d)"

echo "== 4) Testkunde + freigegebenes Angebot (revenue_os, markiert als Abnahmetest) =="
RO() { sudo -u postgres psql -d revenue_os -At -v ON_ERROR_STOP=1 "$@"; }
KID=$(RO -c "INSERT INTO kunden (email,name,firma,quelle,status) VALUES ('abnahme-test@example.invalid','Abnahme Test','Testfirma (Stripe-Testmodus)','abnahme','interessent') ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id")
AID=$(RO -c "INSERT INTO angebote (kunde_id,paket,titel,leistungsumfang,preis,status,freigegeben_von,freigegeben_am,erstellt_von) VALUES ($KID,'starter','Abnahmetest Starter','12 Beitraege, 4 KI-Bilder, Content-Plan',299,'freigegeben','niko.oeben@gmail.com',now(),'abnahme') RETURNING id")
echo "kunde_id=$KID angebot_id=$AID"
echo "== 5) Checkout erstellen =="
CO=$(T checkoutErstellen "{\"json\":{\"angebotId\":$AID}}")
echo "$CO" | python3 -c "
import sys,json
d=json.load(sys.stdin); r=d.get('result',{}).get('data',{}).get('json')
print({'modus':r['modus'],'sessionId':r['sessionId'],'url_praefix':r['url'][:40]} if r else d)"
SID=$(echo "$CO" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['data']['json']['sessionId'])" 2>/dev/null)
echo "SESSION=$SID" > /tmp/abnahme.env
