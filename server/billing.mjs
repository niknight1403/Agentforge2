import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { db, now } from './db.mjs';

let client = null;

export function initBillingStore() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_customers (
      user_id INTEGER PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      stripe_subscription_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      price_id TEXT NOT NULL DEFAULT '',
      current_period_end INTEGER NOT NULL DEFAULT 0,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_sub_user ON billing_subscriptions(user_id, status);
    CREATE TABLE IF NOT EXISTS billing_transactions (
      stripe_object_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd',
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_transactions_user ON billing_transactions(user_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS billing_usage_outbox (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      error_code TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_billing_usage_pending ON billing_usage_outbox(status, next_attempt_at, created_at);
  `);
}

export function getStripeClient() {
  const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) throw Object.assign(new Error('Stripe ist nicht konfiguriert (STRIPE_SECRET_KEY fehlt).'), { code: 'STRIPE_NOT_CONFIGURED', statusCode: 503 });
  if (!client) client = new Stripe(secret, { maxNetworkRetries: 2, timeout: 10_000 });
  return client;
}

export function _setStripeClientForTests(value) { client = value; }

function customerId(value) { return typeof value === 'string' ? value : String(value?.id || ''); }
function userIdFrom(eventObject, fallbackCustomerId = '') {
  const explicit = Number(eventObject?.client_reference_id || eventObject?.metadata?.user_id || eventObject?.metadata?.userId || 0);
  if (Number.isSafeInteger(explicit) && explicit > 0 && db.prepare('SELECT id FROM users WHERE id=?').get(explicit)) return explicit;
  const mapped = fallbackCustomerId && db.prepare('SELECT user_id FROM billing_customers WHERE stripe_customer_id=?').get(fallbackCustomerId);
  return Number(mapped?.user_id || 0) || null;
}
function priceId(subscription) {
  return String(subscription?.items?.data?.[0]?.price?.id || subscription?.plan?.id || '').slice(0, 160);
}
function periodEnd(subscription) {
  return Math.max(0, Number(subscription?.current_period_end || subscription?.items?.data?.[0]?.current_period_end || 0)) * 1000;
}
function subscriptionId(invoice) {
  return customerId(invoice?.subscription || invoice?.parent?.subscription_details?.subscription);
}

function refreshEntitlement(userId) {
  const user = db.prepare('SELECT id, role, plan FROM users WHERE id=?').get(userId);
  if (!user || ['admin', 'superadmin'].includes(user.role) || user.plan === 'elite') return;
  const active = db.prepare("SELECT COUNT(*) AS count FROM billing_subscriptions WHERE user_id=? AND status IN ('active','trialing')").get(userId).count;
  if (active > 0) db.prepare("UPDATE users SET plan='pro', token_budget='5000000', is_unlimited=0 WHERE id=?").run(userId);
  else if (user.plan === 'pro') db.prepare("UPDATE users SET plan='free', token_budget=NULL WHERE id=?").run(userId);
}

function rememberCustomer(userId, stripeCustomerId) {
  if (!userId || !stripeCustomerId) return;
  db.prepare(`INSERT INTO billing_customers(user_id,stripe_customer_id,created_at,updated_at)
    VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=excluded.stripe_customer_id,updated_at=excluded.updated_at`)
    .run(userId, stripeCustomerId, now(), now());
}

/** Persist a verified Stripe event idempotently. Replays may safely reach this function. */
export function applyStripeBillingEvent(event) {
  initBillingStore();
  const object = event?.data?.object || {};
  const type = String(event?.type || '');
  let result = { handled: false, updated: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (type === 'checkout.session.completed') {
      const stripeCustomerId = customerId(object.customer);
      const userId = userIdFrom(object, stripeCustomerId);
      if (userId && stripeCustomerId) rememberCustomer(userId, stripeCustomerId);
      if (userId && object.mode === 'payment' && object.payment_status === 'paid' && object.id) {
        db.prepare(`INSERT INTO billing_transactions(stripe_object_id,event_id,user_id,kind,status,amount_minor,currency,occurred_at)
          VALUES (?,?,?,'checkout','paid',?,?,?) ON CONFLICT(stripe_object_id) DO NOTHING`)
          .run(String(object.id), String(event.id || ''), userId, Math.max(0, Number(object.amount_total) || 0), String(object.currency || 'usd').toLowerCase(), Number(event.created || Math.floor(Date.now()/1000)) * 1000);
      }
      result = { handled: true, updated: !!userId };
    } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(type)) {
      const stripeCustomerId = customerId(object.customer);
      const userId = userIdFrom(object, stripeCustomerId);
      if (userId && object.id && stripeCustomerId) {
        rememberCustomer(userId, stripeCustomerId);
        db.prepare(`INSERT INTO billing_subscriptions(stripe_subscription_id,user_id,stripe_customer_id,status,price_id,current_period_end,cancel_at_period_end,updated_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(stripe_subscription_id) DO UPDATE SET user_id=excluded.user_id,stripe_customer_id=excluded.stripe_customer_id,status=excluded.status,price_id=excluded.price_id,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=excluded.updated_at`)
          .run(String(object.id), userId, stripeCustomerId, String(object.status || (type.endsWith('.deleted') ? 'canceled' : 'unknown')).slice(0, 40), priceId(object), periodEnd(object), object.cancel_at_period_end ? 1 : 0, now());
        refreshEntitlement(userId);
        result = { handled: true, updated: true };
      } else result = { handled: true, updated: false };
    } else if (type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'invoice.payment_action_required') {
      const stripeCustomerId = customerId(object.customer);
      const userId = userIdFrom(object, stripeCustomerId);
      if (userId && object.id) {
        if (stripeCustomerId) rememberCustomer(userId, stripeCustomerId);
        const status = type === 'invoice.paid' ? 'paid' : 'failed';
        db.prepare(`INSERT INTO billing_transactions(stripe_object_id,event_id,user_id,kind,status,amount_minor,currency,occurred_at)
          VALUES (?,?,?,'invoice',?,?,?,?) ON CONFLICT(stripe_object_id) DO UPDATE SET event_id=excluded.event_id,status=excluded.status,amount_minor=excluded.amount_minor,currency=excluded.currency,occurred_at=excluded.occurred_at`)
          .run(String(object.id), String(event.id || ''), userId, status, Math.max(0, Number(type === 'invoice.paid' ? object.amount_paid : object.amount_due) || 0), String(object.currency || 'usd').toLowerCase(), Number(event.created || Math.floor(Date.now()/1000)) * 1000);
        const subId = subscriptionId(object);
        if (subId && type !== 'invoice.paid') {
          db.prepare("UPDATE billing_subscriptions SET status='past_due',updated_at=? WHERE stripe_subscription_id=? AND user_id=?").run(now(), subId, userId);
          refreshEntitlement(userId);
        }
        result = { handled: true, updated: true };
      } else result = { handled: true, updated: false };
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function createCheckoutSession(user) {
  const price = String(process.env.STRIPE_PRICE_ID || '').trim();
  if (!price) throw Object.assign(new Error('STRIPE_PRICE_ID ist nicht konfiguriert.'), { code: 'STRIPE_PRICE_NOT_CONFIGURED', statusCode: 503 });
  const successUrl = safeRedirect(process.env.STRIPE_SUCCESS_URL);
  const cancelUrl = safeRedirect(process.env.STRIPE_CANCEL_URL);
  const stripe = getStripeClient();
  initBillingStore();
  let customer = db.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id=?').get(user.id)?.stripe_customer_id;
  if (!customer) {
    const created = await stripe.customers.create({ email: user.email, metadata: { user_id: String(user.id) } }, { idempotencyKey: `agentforge-customer-${user.id}` });
    customer = created.id;
    rememberCustomer(user.id, customer);
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription', customer, line_items: [{ price, quantity: 1 }],
    success_url: successUrl, cancel_url: cancelUrl,
    client_reference_id: String(user.id), metadata: { user_id: String(user.id) },
    subscription_data: { metadata: { user_id: String(user.id) } }
  }, { idempotencyKey: `agentforge-checkout-${user.id}-${Math.floor(Date.now()/60_000)}` });
  if (!session.url) throw Object.assign(new Error('Stripe hat keine Checkout-URL zurueckgegeben.'), { code: 'STRIPE_CHECKOUT_FAILED', statusCode: 502 });
  return { url: session.url, id: session.id };
}

function safeRedirect(value) {
  const raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error('STRIPE_SUCCESS_URL und STRIPE_CANCEL_URL muessen konfiguriert sein.'), { code: 'STRIPE_REDIRECT_NOT_CONFIGURED', statusCode: 503 });
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw Object.assign(new Error('Stripe-Weiterleitungen muessen HTTPS verwenden.'), { statusCode: 400 });
  return url.toString();
}

export async function createBillingPortalSession(userId) {
  initBillingStore();
  const customer = db.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id=?').get(userId)?.stripe_customer_id;
  if (!customer) throw Object.assign(new Error('Noch kein Stripe-Kundenkonto vorhanden.'), { code: 'BILLING_CUSTOMER_NOT_FOUND', statusCode: 404 });
  const returnUrl = safeRedirect(process.env.STRIPE_PORTAL_RETURN_URL || process.env.STRIPE_SUCCESS_URL);
  const session = await getStripeClient().billingPortal.sessions.create({ customer, return_url: returnUrl });
  return { url: session.url };
}

export function billingSummary(userId) {
  initBillingStore();
  const customer = db.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id=?').get(userId) || null;
  const subscriptions = db.prepare('SELECT stripe_subscription_id, status, price_id, current_period_end, cancel_at_period_end FROM billing_subscriptions WHERE user_id=? ORDER BY updated_at DESC').all(userId);
  const transactions = db.prepare('SELECT stripe_object_id, kind, status, amount_minor, currency, occurred_at FROM billing_transactions WHERE user_id=? ORDER BY occurred_at DESC LIMIT 20').all(userId);
  return { customer: !!customer, subscriptions, transactions };
}

export function adminBillingMetrics(days = 30) {
  initBillingStore();
  const since = now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86_400_000;
  const revenue = db.prepare("SELECT currency, SUM(amount_minor) AS amount_minor, COUNT(*) AS transactions FROM billing_transactions WHERE status='paid' AND occurred_at>=? GROUP BY currency ORDER BY currency").all(since);
  const subscriptions = db.prepare("SELECT COUNT(*) AS active FROM billing_subscriptions WHERE status IN ('active','trialing')").get().active;
  const pendingUsage = db.prepare("SELECT COUNT(*) AS pending FROM billing_usage_outbox WHERE status='PENDING'").get().pending;
  return { windowDays: Math.max(1, Math.min(365, Number(days) || 30)), revenue, activeSubscriptions: subscriptions, pendingUsage };
}

/** Queue provider-measured token usage locally; no network call is made on the LLM request path. */
export function enqueueStripeUsage(userId, quantity) {
  const count = Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(quantity) || 0)));
  if (!userId || !count || !process.env.STRIPE_METER_EVENT_NAME) return false;
  try {
    initBillingStore();
    const billing = db.prepare("SELECT c.stripe_customer_id FROM billing_customers c JOIN billing_subscriptions s ON s.user_id=c.user_id WHERE c.user_id=? AND s.status IN ('active','trialing') LIMIT 1").get(userId);
    if (!billing) return false;
    db.prepare('INSERT INTO billing_usage_outbox(id,user_id,stripe_customer_id,quantity,status,attempts,next_attempt_at,created_at) VALUES (?,?,?, ?,\'PENDING\',0,?,?)')
      .run(randomUUID(), userId, billing.stripe_customer_id, count, now(), now());
    return true;
  } catch (error) {
    console.error('[BillingUsage] could not enqueue usage', { code: error?.code || error?.name || 'DB_ERROR' });
    return false;
  }
}

export async function flushStripeUsage(limit = 100) {
  if (!process.env.STRIPE_METER_EVENT_NAME || !process.env.STRIPE_SECRET_KEY) return { sent: 0, skipped: true };
  initBillingStore();
  const stripe = getStripeClient();
  const rows = db.prepare("SELECT * FROM billing_usage_outbox WHERE status='PENDING' AND next_attempt_at<=? ORDER BY created_at LIMIT ?").all(now(), Math.max(1, Math.min(500, Number(limit) || 100)));
  let sent = 0;
  for (const row of rows) {
    try {
      await stripe.billing.meterEvents.create({
        event_name: process.env.STRIPE_METER_EVENT_NAME,
        identifier: row.id,
        timestamp: Math.floor(Number(row.created_at) / 1000),
        payload: { stripe_customer_id: row.stripe_customer_id, value: String(row.quantity) }
      });
      db.prepare("UPDATE billing_usage_outbox SET status='SENT',sent_at=?,error_code='' WHERE id=? AND status='PENDING'").run(now(), row.id);
      sent++;
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      db.prepare("UPDATE billing_usage_outbox SET attempts=?,status=?,next_attempt_at=?,error_code=? WHERE id=?")
        .run(attempts, attempts >= 10 ? 'DEAD' : 'PENDING', now() + Math.min(3_600_000, 15_000 * (2 ** Math.min(attempts, 8))), String(error?.code || error?.type || 'STRIPE_ERROR').slice(0, 80), row.id);
    }
  }
  return { sent, scanned: rows.length };
}
