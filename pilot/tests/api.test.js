import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, monatJetzt, quotaFuer, verbrauche, PLANS } from "../src/db.js";
import { verarbeiteStripeEvent, planAusPrice, erstelleCheckout } from "../src/billing.js";
import { createApp } from "../src/server.js";

const ANTWORT = JSON.stringify({
  reply: "Guten Tag, fuer 12 Arbeitsplaetze benoetige ich die Anzahl der Nebenstellen und zwei Terminvorschlaege.",
  kategorie: "angebotsanfrage",
  dringlichkeit: "hoch",
  naechster_schritt: "Terminvorschlaege erfragen",
});

function fakeLlm() {
  return async () => ({ inhalt: ANTWORT, provider: "test" });
}

async function starteApp(llm = fakeLlm()) {
  const db = openDatabase(":memory:");
  const app = createApp({ db, llm });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  return { basis, db, server };
}

async function registriere(basis, email = "test@firma.de") {
  const res = await fetch(`${basis}/api/auth/registrieren`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, passwort: "geheim1234", firma: "Muster GmbH" }),
  });
  const cookie = res.headers.get("set-cookie") || "";
  return { res, cookie: cookie.split(";")[0] };
}

test("Datenbank: Trial-Kontingent startet bei 20", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("a@b.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id, plan, status, updated_at) VALUES (1,'trial','active',?)").run(Date.now());
  const q = quotaFuer(db, 1);
  assert.equal(q.planKey, "trial");
  assert.equal(q.frei, 20);
  verbrauche(db, 1);
  assert.equal(quotaFuer(db, 1).frei, 19);
});

test("Datenbank: Verbrauch zaehlt nur im aktuellen Monat", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("a@b.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id, plan, status, updated_at) VALUES (1,'trial','active',?)").run(Date.now());
  db.prepare("INSERT INTO usage_events(user_id, monat, created_at) VALUES (?,?,?)").run(1, "2020-01", Date.now());
  assert.equal(quotaFuer(db, 1).verbraucht, 0);
  verbrauche(db, 1);
  assert.equal(quotaFuer(db, 1).verbraucht, 1);
  assert.equal(monatJetzt(new Date("2026-03-15T00:00:00Z")), "2026-03");
});

test("API: Health antwortet", async () => {
  const { basis, server } = await starteApp();
  const res = await fetch(`${basis}/api/health`);
  const d = await res.json();
  assert.equal(res.status, 200);
  assert.equal(d.ok, true);
  server.close();
});

test("API: Registrierung setzt Cookie und legt Trial an", async () => {
  const { basis, db, server } = await starteApp();
  const { res, cookie } = await registriere(basis);
  assert.equal(res.status, 201);
  assert.match(cookie, /ap_session=/);
  assert.equal(db.prepare("SELECT plan FROM subscriptions WHERE user_id = 1").get().plan, "trial");
  server.close();
});

test("API: doppelte Registrierung wird abgelehnt", async () => {
  const { basis, server } = await starteApp();
  await registriere(basis);
  const { res } = await registriere(basis);
  assert.equal(res.status, 409);
  server.close();
});

test("API: Dashboard braucht Anmeldung", async () => {
  const { basis, server } = await starteApp();
  const res = await fetch(`${basis}/api/dashboard`);
  assert.equal(res.status, 401);
  server.close();
});

test("API: Dashboard liefert Tarif und Kontingent", async () => {
  const { basis, server } = await starteApp();
  const { cookie } = await registriere(basis);
  const res = await fetch(`${basis}/api/dashboard`, { headers: { cookie } });
  const d = await res.json();
  assert.equal(res.status, 200);
  assert.equal(d.plan.key, "trial");
  assert.equal(d.verbrauch.frei, 20);
  server.close();
});

test("API: ohne API-Schluessel kein Zugriff auf /api/v1/reply", async () => {
  const { basis, server } = await starteApp();
  const res = await fetch(`${basis}/api/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." }),
  });
  assert.equal(res.status, 401);
  server.close();
});

test("API: Schluessel anlegen, Anfrage beantworten, Verbrauch steigt", async () => {
  const { basis, db, server } = await starteApp();
  const { cookie } = await registriere(basis);
  const keyRes = await fetch(`${basis}/api/dashboard/key`, { method: "POST", headers: { cookie } });
  const { key } = await keyRes.json();
  assert.match(key, /^ap_/);

  const res = await fetch(`${basis}/api/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone. Wann koennen Sie kommen?" }),
  });
  const d = await res.json();
  assert.equal(res.status, 200);
  assert.equal(d.kategorie, "angebotsanfrage");
  assert.equal(d.meta.frei, 19);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM requests_log").get().c, 1);
  server.close();
});

test("API: zu kurze Nachricht wird abgelehnt und nicht berechnet", async () => {
  const { basis, db, server } = await starteApp();
  const { cookie } = await registriere(basis);
  const { key } = await (await fetch(`${basis}/api/dashboard/key`, { method: "POST", headers: { cookie } })).json();
  const res = await fetch(`${basis}/api/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ nachricht: "Hi" }),
  });
  assert.equal(res.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events").get().c, 0);
  server.close();
});

test("API: aufgebrauchtes Kontingent liefert 402", async () => {
  const { basis, db, server } = await starteApp();
  const { cookie } = await registriere(basis);
  const { key } = await (await fetch(`${basis}/api/dashboard/key`, { method: "POST", headers: { cookie } })).json();
  for (let i = 0; i < PLANS.trial.quota; i++) verbrauche(db, 1);
  const res = await fetch(`${basis}/api/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." }),
  });
  const d = await res.json();
  assert.equal(res.status, 402);
  assert.equal(d.plan, "trial");
  server.close();
});

test("API: widerrufener Schluessel wird abgewiesen", async () => {
  const { basis, server } = await starteApp();
  const { cookie } = await registriere(basis);
  const { key } = await (await fetch(`${basis}/api/dashboard/key`, { method: "POST", headers: { cookie } })).json();
  const liste = await (await fetch(`${basis}/api/dashboard`, { headers: { cookie } })).json();
  await fetch(`${basis}/api/dashboard/key/${liste.keys[0].id}/revoke`, { method: "POST", headers: { cookie } });
  const res = await fetch(`${basis}/api/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." }),
  });
  assert.equal(res.status, 401);
  server.close();
});

test("API: LLM-Ausfall meldet 503, ohne Kontingent zu verbrauchen", async () => {
  const kaputt = async () => { throw Object.assign(new Error("keine Route"), { code: "LLM_UNAVAILABLE" }); };
  const { basis, db, server } = await starteApp(kaputt);
  const { cookie } = await registriere(basis);
  const { key } = await (await fetch(`${basis}/api/dashboard/key`, { method: "POST", headers: { cookie } })).json();
  const res = await fetch(`${basis}/api/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." }),
  });
  assert.equal(res.status, 503);
  const d = await res.json();
  assert.equal(d.code, "LLM_UNAVAILABLE");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events").get().c, 0);
  server.close();
});

test("Billing: Checkout-Session aktiviert den Plan", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("a@b.de", "x", Date.now());
  const event = {
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: { mode: "subscription", payment_status: "paid", metadata: { user_id: "1", plan: "pro" }, customer: "cus_1", subscription: "sub_1" } },
  };
  const r = verarbeiteStripeEvent(db, event);
  assert.equal(r.ok, true);
  const sub = db.prepare("SELECT plan, status FROM subscriptions WHERE user_id = 1").get();
  assert.equal(sub.plan, "pro");
  assert.equal(sub.status, "active");
  assert.equal(quotaFuer(db, 1).plan.quota, 1000);
});

test("Billing: dasselbe Event wird nicht doppelt verarbeitet", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("a@b.de", "x", Date.now());
  const event = {
    id: "evt_2",
    type: "checkout.session.completed",
    data: { object: { metadata: { user_id: "1", plan: "starter" }, customer: "cus_2", subscription: "sub_2" } },
  };
  verarbeiteStripeEvent(db, event);
  const zweite = verarbeiteStripeEvent(db, event);
  assert.equal(zweite.doppelt, true);
});

test("Billing: Kuendigung setzt Konto auf Trial zurueck", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("a@b.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id, plan, status, stripe_subscription, updated_at) VALUES (1,'pro','active','sub_9',?)").run(Date.now());
  verarbeiteStripeEvent(db, {
    id: "evt_3",
    type: "customer.subscription.deleted",
    data: { object: { metadata: { user_id: "1" }, id: "sub_9", customer: "cus_9" } },
  });
  const sub = db.prepare("SELECT plan, status FROM subscriptions WHERE user_id = 1").get();
  assert.equal(sub.plan, "trial");
  assert.equal(sub.status, "cancelled");
});

test("Billing: Preis-ID wird dem richtigen Plan zugeordnet", () => {
  process.env.STRIPE_PRICE_PRO = "price_pro_123";
  assert.equal(planAusPrice("price_pro_123"), "pro");
  assert.equal(planAusPrice("price_unbekannt"), null);
});

test("Demo: oeffentlicher Sofort-Test liefert eine Antwort ohne Konto", async () => {
  const { basis, db, server } = await starteApp();
  const res = await fetch(`${basis}/api/public/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefonarbeitsplaetze im Buero." }),
  });
  const d = await res.json();
  assert.equal(res.status, 200);
  assert.equal(d.kategorie, "angebotsanfrage");
  assert.equal(d.meta.limit, 3);
  assert.equal(d.meta.frei, 2);
  // Der Test darf kein Kontingent eines Kontos verbrauchen.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events").get().c, 0);
  server.close();
});

test("Demo: nach drei Anfragen ist Schluss am selben Tag", async () => {
  const { basis, server } = await starteApp();
  const schicken = () => fetch(`${basis}/api/public/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefonarbeitsplaetze im Buero." }),
  });
  for (let i = 0; i < 3; i++) assert.equal((await schicken()).status, 200);
  const vierte = await schicken();
  const d = await vierte.json();
  assert.equal(vierte.status, 429);
  assert.equal(d.registrieren, "./registrieren");
  server.close();
});

test("Demo: zu kurze Eingabe wird abgewiesen und zaehlt nicht", async () => {
  const { basis, server } = await starteApp();
  const res = await fetch(`${basis}/api/public/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nachricht: "Hi" }),
  });
  assert.equal(res.status, 400);
  const status = await (await fetch(`${basis}/api/public/demo/status`)).json();
  assert.equal(status.frei, 3);
  server.close();
});


test("Billing: Abo-Aenderung ohne Stripe-Metadaten nutzt bestehende Subscription-ID", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("billing@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id, plan, status, stripe_customer, stripe_subscription, updated_at) VALUES (1,'pro','active','cus_known','sub_known',?)").run(Date.now());
  process.env.STRIPE_PRICE_STARTER = "price_starter_test";
  const result = verarbeiteStripeEvent(db, {
    id: "evt_no_metadata_updated",
    type: "customer.subscription.updated",
    data: { object: {
      id: "sub_known", customer: "cus_known", status: "active",
      items: { data: [{ price: { id: "price_starter_test" } }] }
    } }
  });
  assert.equal(result.ok, true);
  const sub = db.prepare("SELECT plan, stripe_subscription FROM subscriptions WHERE user_id=1").get();
  assert.equal(sub.plan, "starter");
  assert.equal(sub.stripe_subscription, "sub_known");
});

test("Billing: Kuendigung ohne Stripe-Metadaten wird zugeordnet", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)").run("cancel@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id, plan, status, stripe_customer, stripe_subscription, updated_at) VALUES (1,'pro','active','cus_cancel','sub_cancel',?)").run(Date.now());
  const result = verarbeiteStripeEvent(db, {
    id: "evt_no_metadata_deleted",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_cancel", customer: "cus_cancel" } }
  });
  assert.equal(result.ok, true);
  assert.equal(db.prepare("SELECT status FROM subscriptions WHERE user_id=1").get().status, "cancelled");
});

test("Billing: unbekannte Abo-Ereignisse werden nicht als verarbeitet quittiert", () => {
  const db = openDatabase(":memory:");
  const result = verarbeiteStripeEvent(db, {
    id: "evt_unknown_subscription",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_unknown", customer: "cus_unknown" } }
  });
  assert.equal(result.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM billing_events").get().c, 0);
});


test("Billing: unpaid Checkout gibt kein bezahltes Kontingent frei", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("unpaid@firma.de", "x", Date.now());
  const event = {
    id: "evt_checkout_unpaid", type: "checkout.session.completed",
    data: { object: {
      mode: "subscription", payment_status: "unpaid",
      metadata: { user_id: "1", plan: "pro" },
      customer: "cus_unpaid", subscription: "sub_unpaid"
    } }
  };
  const result = verarbeiteStripeEvent(db, event);
  assert.equal(result.ok, true);
  assert.equal(db.prepare("SELECT status FROM subscriptions WHERE user_id=1").get().status, "pending");
  assert.equal(quotaFuer(db, 1).planKey, "trial");
  assert.equal(verarbeiteStripeEvent(db, event).doppelt, true);
});

test("Billing: subscription-event aktiviert nach unpaid Checkout bei bestaetigtem Abo", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("later@firma.de", "x", Date.now());
  verarbeiteStripeEvent(db, {
    id: "evt_checkout_pending", type: "checkout.session.completed",
    data: { object: {
      mode: "subscription", payment_status: "unpaid",
      metadata: { user_id: "1", plan: "pro" },
      customer: "cus_later", subscription: "sub_later"
    } }
  });
  process.env.STRIPE_PRICE_PRO = "price_pro_later";
  const result = verarbeiteStripeEvent(db, {
    id: "evt_subscription_later", type: "customer.subscription.updated",
    data: { object: {
      id: "sub_later", customer: "cus_later", status: "active",
      items: { data: [{ price: { id: "price_pro_later" } }] }
    } }
  });
  assert.equal(result.ok, true);
  assert.equal(quotaFuer(db, 1).planKey, "pro");
});


test("Billing: verspaeteter unbezahlter Checkout setzt aktive Subscription nicht zurueck", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("order@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id,plan,status,stripe_customer,stripe_subscription,updated_at) VALUES (1,'pro','active','cus_order','sub_order',?)").run(Date.now());
  const r = verarbeiteStripeEvent(db, {
    id: "evt_late_unpaid", type: "checkout.session.completed",
    data: { object: {
      mode: "subscription", payment_status: "unpaid",
      metadata: { user_id: "1", plan: "pro" },
      customer: "cus_order", subscription: "sub_order"
    } }
  });
  assert.equal(r.ok, true);
  assert.equal(r.veraltet, true);
  assert.equal(quotaFuer(db, 1).planKey, "pro");
});

test("Billing: verspaeteter bezahlter Checkout reaktiviert keine Kuendigung", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("cancelled@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id,plan,status,stripe_customer,stripe_subscription,updated_at) VALUES (1,'trial','cancelled','cus_order2','sub_order2',?)").run(Date.now());
  const r = verarbeiteStripeEvent(db, {
    id: "evt_late_paid", type: "checkout.session.completed",
    data: { object: {
      mode: "subscription", payment_status: "paid",
      metadata: { user_id: "1", plan: "pro" },
      customer: "cus_order2", subscription: "sub_order2"
    } }
  });
  assert.equal(r.veraltet, true);
  assert.equal(quotaFuer(db, 1).planKey, "trial");
});

test("Billing: aktives Abo darf nicht durch weiteren Checkout doppelt angelegt werden", async () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("active@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id,plan,status,stripe_customer,stripe_subscription,updated_at) VALUES (1,'pro','active','cus_active','sub_active',?)").run(Date.now());
  process.env.STRIPE_PRICE_PRO = "price_pro_test";
  let calls = 0;
  const stripe = { checkout: { sessions: { create: async () => { calls++; return { url: "https://example.test/checkout" }; } } } };
  await assert.rejects(
    () => erstelleCheckout({ stripe, db, user: { id: 1, email: "active@firma.de" }, planKey: "pro", basisUrl: "https://app.example.test" }),
    { status: 409 }
  );
  assert.equal(calls, 0);
});

test("Billing: widerspruechliche User-Metadaten duerfen bestehendes Abo nicht uebernehmen", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("first@firma.de", "x", Date.now());
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("second@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id,plan,status,stripe_customer,stripe_subscription,updated_at) VALUES (1,'pro','active','cus_owner','sub_owner',?)").run(Date.now());
  process.env.STRIPE_PRICE_PRO = "price_pro_owner";
  const result = verarbeiteStripeEvent(db, {
    id: "evt_conflict_owner", type: "customer.subscription.updated",
    data: { object: {
      id: "sub_owner", customer: "cus_owner", status: "active", metadata: { user_id: "2", plan: "pro" },
      items: { data: [{ price: { id: "price_pro_owner" } }] }
    } }
  });
  assert.equal(result.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM billing_events").get().c, 0);
  assert.equal(db.prepare("SELECT stripe_subscription FROM subscriptions WHERE user_id=1").get().stripe_subscription, "sub_owner");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE user_id=2").get().c, 0);
});


test("Billing: Fehler beim Ereignisprotokoll rollt Abo-Aenderung zurueck", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)").run("rollback@firma.de", "x", Date.now());
  db.prepare("INSERT INTO subscriptions(user_id,plan,status,updated_at) VALUES (1,'trial','active',?)").run(Date.now());
  db.exec(`CREATE TRIGGER billing_receipt_abort BEFORE INSERT ON billing_events
    BEGIN SELECT RAISE(ABORT, 'test receipt unavailable'); END;`);
  const event = {
    id: "evt_rollback", type: "checkout.session.completed",
    data: { object: {
      mode: "subscription", payment_status: "paid",
      metadata: { user_id: "1", plan: "pro" },
      customer: "cus_rollback", subscription: "sub_rollback"
    } }
  };
  assert.throws(() => verarbeiteStripeEvent(db, event), /test receipt unavailable/);
  const after = db.prepare("SELECT plan, status, stripe_subscription FROM subscriptions WHERE user_id=1").get();
  assert.equal(after.plan, "trial");
  assert.equal(after.status, "active");
  assert.equal(after.stripe_subscription, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM billing_events").get().c, 0);
  db.exec("DROP TRIGGER billing_receipt_abort");
  assert.equal(verarbeiteStripeEvent(db, event).ok, true);
  assert.equal(db.prepare("SELECT plan FROM subscriptions WHERE user_id=1").get().plan, "pro");
});
