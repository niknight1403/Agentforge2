# Agentforge2 SaaS Gateway and Billing

## Gateway authentication

Session-authenticated administrators can create keys at `POST /api/v1/gateway-keys` with `{ "label": "CI", "role": "operator", "villaIds": [1], "ttlSeconds": 2592000 }`. The plaintext key is returned once. Redis caches active key claims with an expiry; the SQLite key registry remains authoritative for ownership, expiry, and revocation. Revoke with `DELETE /api/v1/gateway-keys/{id}`. Send the key as `X-API-Key`. JWTs use HS256, fixed issuer/audience, 60–3600 second expiry and role scopes; mint them with `POST /api/admin/gateway-token`.

Roles are `reader` (`villas:read`), `operator` (read, start/stop villas and create tasks), and `admin` (operator scopes plus metrics and billing read). Non-admin credentials require a villa allowlist. Only superadmins may mint admin credentials. Gateway API paths include `GET /api/v1/gateway/villas`, `POST /api/v1/gateway/villas/{id}/start|stop`, `POST /api/v1/gateway/tasks`, and `GET /api/v1/gateway/metrics`.

## Stripe configuration

Set secrets in the deployment environment or an untracked `.env` file. Do not commit live keys.

```dotenv
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
STRIPE_METER_EVENT_NAME=agentforge_tokens
STRIPE_SUCCESS_URL=https://your-host.example/account?billing=success
STRIPE_CANCEL_URL=https://your-host.example/account?billing=cancel
STRIPE_PORTAL_RETURN_URL=https://your-host.example/account
```

Register webhook endpoint `/api/v1/webhooks/stripe` for checkout completion, subscription create/update/delete/pause/resume, `invoice.paid`, `invoice.payment_failed`, and `invoice.payment_action_required`. The endpoint verifies the raw request body signature, persists event effects idempotently in the existing local database, and releases its event claim when persistence fails so Stripe can retry. Meter usage is queued locally and flushed by a retrying outbox. Configure a Stripe meter event whose customer payload field is `stripe_customer_id` and value is the token quantity. Checkout and customer portal links are exposed at `/api/billing/checkout` and `/api/billing/portal` to signed-in users.

## Token budget, kill switch and metrics

Defaults are five million tokens and an estimated USD 5 per UTC day. Set `VF_GLOBAL_DAILY_TOKEN_BUDGET`, `VF_GLOBAL_DAILY_COST_USD`, and `VF_LLM_ESTIMATED_COST_PER_1K_USD` to tune them. The estimate is an administrator-configured budget guard, not an invoice-grade provider cost; free routes accrue zero estimated dollars. At the monetary limit the router suppresses paid routes and continues on explicitly free routes. At the token limit all LLM routing stops until the next UTC day. The authenticated admin endpoint `/api/admin/metrics` reports task counts, daily usage/budget, sampled HTTP p50/p95 latency, and 30-day paid transaction totals. The dashboard polls it every 15 seconds for administrator accounts. HTTP latency samples are intentionally process-local and bounded; LLM usage, billing, keys and queue state persist in SQLite/PostgreSQL/Redis respectively.

The Agent Runtime publishes terminal failures to `${VF_AGENT_TASK_STREAM}:dead` through its PostgreSQL transactional outbox after retry exhaustion. Consumers can attach a dedicated Redis consumer group to that stream for alerting and manual replay workflows.
