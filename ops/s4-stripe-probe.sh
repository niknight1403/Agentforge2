set -u
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
E=$(tr '\0' '\n' < /proc/$PID/environ)
echo "== Stripe-Konfiguration des Dienstes (nur Praefix/Laenge) =="
for N in STRIPE_MODE STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PAYMENT_LINK STRIPE_PRICE_ID STRIPE_PRICE_ID_LITE STRIPE_PRICE_ID_PRO STRIPE_PRICE_ID_EXPERT APP_BASE_URL; do
  V=$(echo "$E" | grep "^$N=" | cut -d= -f2-)
  if [ -z "$V" ]; then echo "$N: (nicht gesetzt)"; else
    case "$N" in
      STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET) echo "$N: gesetzt, Praefix=${V:0:8}, Laenge=${#V}";;
      APP_BASE_URL|STRIPE_MODE) echo "$N: $V";;
      *) echo "$N: gesetzt, Praefix=${V:0:6}, Laenge=${#V}";;
    esac
  fi
done
echo "== Stripe-Konto per API (nur Metadaten) =="
KEY=$(echo "$E" | grep '^STRIPE_SECRET_KEY=' | cut -d= -f2-)
if [ -n "$KEY" ]; then
  curl -s -m 15 -u "$KEY:" https://api.stripe.com/v1/account | jq -r '"Konto: charges_enabled=\(.charges_enabled) payouts_enabled=\(.payouts_enabled) country=\(.country) livemode-Key=\(if (env.K // "") == "" then "n/a" else "" end)"' 2>/dev/null | cut -c1-200
  echo "-- Produkte (max 10) --"
  curl -s -m 15 -u "$KEY:" "https://api.stripe.com/v1/products?limit=10&active=true" | jq -r '.data[] | "\(.id) | \(.name) | livemode=\(.livemode)"' 2>/dev/null | head -10
  echo "-- Webhook-Endpoints --"
  curl -s -m 15 -u "$KEY:" "https://api.stripe.com/v1/webhook_endpoints?limit=10" | jq -r '.data[] | "\(.url) | \(.status) | events=\(.enabled_events|length)"' 2>/dev/null | head -5
fi
