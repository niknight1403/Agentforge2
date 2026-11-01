#!/usr/bin/env bash
# Legt Stripe-Produkte, Monatspreise und den Webhook-Endpunkt fuer AnfragePilot an
# und schreibt die IDs in die Dienst-Umgebung. Idempotent: vorhandene Werte bleiben.
set -euo pipefail

ZIEL=/opt/anfragepilot
ENV_DATEI="$ZIEL/pilot.env"
DIENST=anfragepilot.service

[ -f "$ENV_DATEI" ] || { echo "FEHLER: $ENV_DATEI fehlt"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_DATEI"; set +a

[ -n "${STRIPE_SECRET_KEY:-}" ] || { echo "FEHLER: STRIPE_SECRET_KEY fehlt in $ENV_DATEI"; exit 1; }

API="https://api.stripe.com/v1"
setze() {  # setze KEY WERT  -> ergaenzt/ersetzt eine Zeile in pilot.env
  local key="$1" wert="$2"
  if grep -qE "^${key}=" "$ENV_DATEI"; then
    sed -i "s|^${key}=.*|${key}=${wert}|" "$ENV_DATEI"
  else
    echo "${key}=${wert}" >> "$ENV_DATEI"
  fi
  echo "  ${key} = ${wert}"
}

echo "== Stripe-Modus pruefen =="
MODUS=$(curl -s -m 20 "$API/balance" -u "$STRIPE_SECRET_KEY:" | python3 -c "import json,sys; d=json.load(sys.stdin); print('LIVE' if d.get('livemode') else 'TEST')" 2>/dev/null || echo "UNBEKANNT")
echo "Stripe-Modus: $MODUS"

produkt_und_preis() {  # produkt_und_preis PLAN NAME CENT_BETRAG ENVKEY
  local plan="$1" name="$2" cent="$3" envkey="$4"
  if [ -n "$(grep -E "^${envkey}=.+" "$ENV_DATEI" || true)" ]; then
    echo "  $plan: bereits konfiguriert ($(grep -E "^${envkey}=" "$ENV_DATEI" | cut -d= -f2))"
    return 0
  fi
  local prod preis
  prod=$(curl -s -m 25 "$API/products" -u "$STRIPE_SECRET_KEY:" \
    -d "name=AnfragePilot $name" \
    -d "description=KI-Antwortassistent fuer Kundenanfragen - Tarif $name" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  [ -n "$prod" ] || { echo "  FEHLER: Produkt $name nicht angelegt"; return 1; }

  preis=$(curl -s -m 25 "$API/prices" -u "$STRIPE_SECRET_KEY:" \
    -d "product=$prod" -d "unit_amount=$cent" -d "currency=eur" -d "recurring[interval]=month" \
    -d "nickname=$name monatlich" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  [ -n "$preis" ] || { echo "  FEHLER: Preis $name nicht angelegt"; return 1; }

  setze "$envkey" "$preis"
}

echo "== Produkte und Monatspreise =="
produkt_und_preis starter  "Starter"  4900  STRIPE_PRICE_STARTER
produkt_und_preis pro      "Pro"      9900  STRIPE_PRICE_PRO
produkt_und_preis business "Business" 19900 STRIPE_PRICE_BUSINESS

echo "== Webhook-Endpunkt =="
if [ -n "$(grep -E '^STRIPE_WEBHOOK_SECRET=.+' "$ENV_DATEI" || true)" ]; then
  echo "  bereits konfiguriert (Secret vorhanden)"
else
  ANDWORT=$(curl -s -m 30 "$API/webhook_endpoints" -u "$STRIPE_SECRET_KEY:" \
    --data-urlencode "url=https://hub.cybersarah-ki.com/pilot/api/billing/webhook" \
    -d "enabled_events[]=checkout.session.completed" \
    -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.updated" \
    -d "enabled_events[]=customer.subscription.deleted" \
    -d "enabled_events[]=invoice.payment_failed" \
    -d "description=AnfragePilot Abo-Ereignisse")
  SECRET=$(printf '%s' "$ANDWORT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('secret',''))")
  WID=$(printf '%s' "$ANDWORT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  if [ -n "$SECRET" ]; then
    setze STRIPE_WEBHOOK_SECRET "$SECRET"
    echo "  Webhook angelegt: ${WID}"
  else
    echo "  FEHLER beim Anlegen: $(printf '%s' "$ANDWORT" | head -c 200)"
  fi
fi

chown ubuntu:ubuntu "$ENV_DATEI"
chmod 600 "$ENV_DATEI"

echo "== Dienst neu starten =="
systemctl restart "$DIENST"
for i in $(seq 1 15); do
  [ "$(systemctl is-active "$DIENST" 2>/dev/null || true)" = "active" ] && { echo "aktiv nach ${i}s"; break; }
  sleep 1
done
systemctl is-active "$DIENST"

echo "== Probe =="
sleep 1
curl -s -m 10 http://127.0.0.1:3910/api/plans | head -c 400; echo ""

echo "== Konfigurierte Variablen (ohne Geheimwerte) =="
grep -E '^(STRIPE_PRICE_|STRIPE_WEBHOOK_SECRET=)' "$ENV_DATEI" | sed 's/=whsec_.*/=whsec_***/'
echo "STRIPE_OK"
