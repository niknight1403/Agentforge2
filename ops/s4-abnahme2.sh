set -u
cd /opt/ccc/repo
git fetch -q origin feature/ai-influenza-phase7 && git reset -q --hard origin/feature/ai-influenza-phase7 && git log --oneline -1 | cut -c1-80

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
RO() { sudo -u postgres psql -d revenue_os -Atq -v ON_ERROR_STOP=1 "$@" | head -1; }
KID=$(RO -c "INSERT INTO kunden (email,name,firma,quelle,status) VALUES ('abnahme-test@example.invalid','Abnahme Test','Testfirma (Stripe-Testmodus)','abnahme','interessent') ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id")
RO -c "DELETE FROM angebote WHERE erstellt_von='abnahme' AND kunde_id=$KID" >/dev/null
AID=$(RO -c "INSERT INTO angebote (kunde_id,paket,titel,leistungsumfang,preis,status,freigegeben_von,freigegeben_am,erstellt_von) VALUES ($KID,'starter','Abnahmetest Starter','12 Beitraege, 4 KI-Bilder, Content-Plan',299,'freigegeben','niko.oeben@gmail.com',now(),'abnahme') RETURNING id")
echo "kunde_id=$KID angebot_id=$AID"
echo "== 5) Checkout erstellen =="
CO=$(T checkoutErstellen "{\"json\":{\"angebotId\":$AID}}")
echo "$CO" | python3 -c "
import sys,json
d=json.load(sys.stdin); r=d.get('result',{}).get('data',{}).get('json')
print({'modus':r['modus'],'sessionId':r['sessionId'],'url_praefix':r['url'][:40]} if r else d)"
SID=$(echo "$CO" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['data']['json']['sessionId'])" 2>/dev/null)
echo "SESSION=${SID:-KEINE}"
[ -z "${SID:-}" ] && { echo "ABBRUCH: kein Checkout"; exit 1; }

echo "== 6) Zahlung mit Stripe-TESTkarte (pm_card_visa) per Test-API, Metadaten wie im Checkout =="
cat > /tmp/pay.py <<'PY2'
import os, json, base64, urllib.request, urllib.error, urllib.parse, sys
k = os.environ["STRIPE_TEST_KEY"]; assert k.startswith("sk_test_"), "Abbruch: kein Test-Key"
auth = "Basic " + base64.b64encode((k + ":").encode()).decode()
def call(method, path, data=None):
    body = urllib.parse.urlencode(data, doseq=True).encode() if data else None
    r = urllib.request.Request("https://api.stripe.com/v1" + path, data=body, method=method, headers={"Authorization": auth})
    try: return json.load(urllib.request.urlopen(r, timeout=40))
    except urllib.error.HTTPError as e: return json.load(e)
kunde_id, angebot_id = sys.argv[1], sys.argv[2]
META = {"metadata[source]": "cybersarah-ai-influenza", "metadata[paket]": "starter", "metadata[kundeId]": kunde_id, "metadata[angebotId]": angebot_id, "metadata[modus]": "test"}
prices = call("GET", "/prices?" + urllib.parse.urlencode({"lookup_keys[]": "ai_influenza_starter_monthly_test", "limit": 1}))
price = prices["data"][0]; assert price["livemode"] is False and price["unit_amount"] == 29900
cust = call("POST", "/customers", {"email": "abnahme-test@example.invalid", "name": "Abnahme Test", **META})
assert cust.get("livemode") is False, cust
print("Kunde:", cust["id"], "livemode=", cust["livemode"])
# Testkarte 4242 4242 4242 4242 ueber das dokumentierte Test-Token anlegen und am Kunden hinterlegen
pm = call("POST", "/payment_methods", {"type": "card", "card[token]": "tok_visa"})
if "error" in pm: print("PM-Fehler:", pm["error"]["message"]); sys.exit(1)
att = call("POST", f"/payment_methods/{pm['id']}/attach", {"customer": cust["id"]})
if "error" in att: print("Attach-Fehler:", att["error"]["message"]); sys.exit(1)
call("POST", f"/customers/{cust['id']}", {"invoice_settings[default_payment_method]": pm["id"]})
print("Testkarte:", att["card"]["brand"], "endet auf", att["card"]["last4"], "livemode=", att["livemode"])
sub = call("POST", "/subscriptions", {"customer": cust["id"], "items[0][price]": price["id"], "default_payment_method": pm["id"], **META})
if "error" in sub: print("Subscription-Fehler:", sub["error"]["message"]); sys.exit(1)
print("Subscription:", sub["id"], "status=", sub["status"], "livemode=", sub["livemode"])
open("/tmp/abnahme_sub.txt", "w").write(sub["id"])
PY2
STRIPE_TEST_KEY="$STRIPE_TEST_KEY" python3 /tmp/pay.py "$KID" "$AID"
rm -f /tmp/pay.py
echo "== 7) Auf echten Webhook warten (max 60 s) =="
for i in $(seq 1 12); do
  N=$(sudo -u postgres psql -d cybersarah -Atq -c "SELECT count(*) FROM \"aiStripeEreignisse\" WHERE verarbeitet")
  [ "${N:-0}" -ge 1 ] && break; sleep 5
done
echo "== 8) Ergebnis in der Datenbank =="
sudo -u postgres psql -d cybersarah -At -c "SELECT 'ereignis: '||event_typ||' | '||aktion||' | verarbeitet='||verarbeitet||' | modus='||modus FROM \"aiStripeEreignisse\" ORDER BY id"
sudo -u postgres psql -d cybersarah -At -c "SELECT 'auftrag: paket='||paket||' status='||status||' abo='||abo_status||' modus='||modus FROM \"aiKundenAuftraege\""
sudo -u postgres psql -d cybersarah -At -c "SELECT 'zahlung: '||betrag_cent||' Cent '||status||' modus='||modus FROM \"aiZahlungen\"" 
echo "== 9) umsatz-Procedure =="
curl -s -m 15 -H "$H" http://127.0.0.1:13000/api/trpc/aiInfluenza.umsatz | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['data']['json'])"
