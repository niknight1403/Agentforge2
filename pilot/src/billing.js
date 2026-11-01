import Stripe from "stripe";
import { PLANS, stripePriceFuer } from "./db.js";

/**
 * Stripe-Billing: Checkout-Sessions fuer Abos und Webhook-Verarbeitung.
 * Ohne STRIPE_SECRET_KEY meldet die App das klar (503) statt still zu scheitern.
 */

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2024-06-20" });
}

export function planAusPrice(priceId) {
  if (!priceId) return null;
  for (const key of Object.keys(PLANS)) {
    if (stripePriceFuer(key) === priceId) return key;
  }
  return null;
}

export async function erstelleCheckout({ stripe, db, user, planKey, basisUrl }) {
  const plan = PLANS[planKey];
  const priceId = stripePriceFuer(planKey);
  if (!plan || !priceId) throw Object.assign(new Error("Plan nicht kaufbar konfiguriert"), { status: 400 });
  const sub = db.prepare("SELECT stripe_customer FROM subscriptions WHERE user_id = ?").get(user.id);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer: sub?.stripe_customer || undefined,
    customer_email: sub?.stripe_customer ? undefined : user.email,
    client_reference_id: String(user.id),
    metadata: { user_id: String(user.id), plan: planKey },
    allow_promotion_codes: true,
    success_url: `${basisUrl}/app?checkout=erfolg`,
    cancel_url: `${basisUrl}/preise?checkout=abgebrochen`,
  });
  return session;
}

/**
 * Verarbeitet ein signaturgeprueftes Stripe-Event. Idempotent ueber die
 * Event-ID: ein doppelt zugestelltes Event aendert nichts ein zweites Mal.
 */
export function verarbeiteStripeEvent(db, event) {
  const schonDa = db.prepare("SELECT id FROM billing_events WHERE id = ?").get(event.id);
  if (schonDa) return { ok: true, doppelt: true };

  const jetzt = Date.now();
  const speichere = db.prepare("INSERT INTO billing_events(id, typ, payload, created_at) VALUES (?,?,?,?)");
  const setzeAbo = db.prepare(`
    INSERT INTO subscriptions(user_id, plan, status, stripe_customer, stripe_subscription, current_period_end, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      status = excluded.status,
      stripe_customer = COALESCE(excluded.stripe_customer, subscriptions.stripe_customer),
      stripe_subscription = COALESCE(excluded.stripe_subscription, subscriptions.stripe_subscription),
      current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end),
      updated_at = excluded.updated_at
  `);

  const t = event.type;
  const obj = event.data?.object || {};

  if (t === "checkout.session.completed") {
    const userId = Number(obj.metadata?.user_id || obj.client_reference_id);
    const planKey = obj.metadata?.plan;
    if (!userId || !planKey) return { ok: false, grund: "user_id oder plan fehlt" };
    setzeAbo.run(userId, planKey, "active", obj.customer || null, obj.subscription || null, null, jetzt);
  } else if (t === "customer.subscription.updated" || t === "customer.subscription.created") {
    const userId = Number(obj.metadata?.user_id);
    const planKey = planAusPrice(obj.items?.data?.[0]?.price?.id) || obj.metadata?.plan;
    if (!userId) return { ok: false, grund: "user_id fehlt" };
    const status = ["active", "trialing"].includes(obj.status) ? "active" : obj.status === "past_due" ? "past_due" : "inactive";
    setzeAbo.run(userId, planKey || "trial", status, obj.customer || null, obj.id || null, obj.current_period_end ? obj.current_period_end * 1000 : null, jetzt);
  } else if (t === "customer.subscription.deleted") {
    const userId = Number(obj.metadata?.user_id);
    if (!userId) return { ok: false, grund: "user_id fehlt" };
    setzeAbo.run(userId, "trial", "cancelled", obj.customer || null, obj.id || null, null, jetzt);
  } else if (t === "invoice.payment_failed") {
    const subId = obj.subscription;
    const row = subId ? db.prepare("SELECT user_id FROM subscriptions WHERE stripe_subscription = ?").get(subId) : null;
    if (row) setzeAbo.run(row.user_id, "trial", "past_due", obj.customer || null, subId, null, jetzt);
  } else {
    speichere.run(event.id, t, JSON.stringify(event), jetzt);
    return { ok: true, ignoriert: true };
  }

  speichere.run(event.id, t, JSON.stringify(event), jetzt);
  return { ok: true, typ: t };
}
