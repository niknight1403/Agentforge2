import express from "express";
import cookieParser from "cookie-parser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { openDatabase, PLANS, quotaFuer, verbrauche, stripePriceFuer } from "./db.js";
import { hashPasswort, pruefePasswort, emailOk, legeSessionAn, sessionNutzer, COOKIE, erzeugeApiKey, nutzerPerApiKey } from "./auth.js";
import { beantworteAnfrage, AnfrageFehler } from "./product.js";
import { llmChat } from "./llm.js";
import { stripeClient, erstelleCheckout, verarbeiteStripeEvent } from "./billing.js";

const HIER = dirname(fileURLToPath(import.meta.url));
const OEFFENTLICH = join(HIER, "..", "public");

export function createApp({ db = openDatabase(), llm = (m, o) => llmChat(m, o) } = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Webhook braucht den Rohkoerper fuer die Signaturpruefung.
  app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
    const stripe = stripeClient();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) return res.status(503).json({ error: "Billing ist nicht konfiguriert" });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
    } catch (e) {
      return res.status(400).json({ error: "Signatur ungueltig" });
    }
    try {
      const ergebnis = verarbeiteStripeEvent(db, event);
      return res.json({ received: true, ...ergebnis });
    } catch (e) {
      return res.status(500).json({ error: "Event konnte nicht verarbeitet werden" });
    }
  });

  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use(express.static(OEFFENTLICH, { extensions: ["html"] }));

  // Einfache Sperre gegen Massenaufrufe pro IP (in-memory, ausreichend fuer eine Instanz).
  const treffer = new Map();
  function begrenze(max, fensterMs) {
    return (req, res, next) => {
      const schluessel = (req.ip || "unbekannt") + ":" + req.path;
      const jetzt = Date.now();
      const eintrag = treffer.get(schluessel) || { anzahl: 0, bis: jetzt + fensterMs };
      if (jetzt > eintrag.bis) { eintrag.anzahl = 0; eintrag.bis = jetzt + fensterMs; }
      eintrag.anzahl += 1;
      treffer.set(schluessel, eintrag);
      if (eintrag.anzahl > max) return res.status(429).json({ error: "Zu viele Anfragen, bitte kurz warten" });
      next();
    };
  }

  function mitSession(req, res, next) {
    const nutzer = sessionNutzer(db, req.cookies?.[COOKIE]);
    if (!nutzer) return res.status(401).json({ error: "Nicht angemeldet" });
    req.nutzer = nutzer;
    next();
  }

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, service: "anfragepilot", version: "0.1.0", zeit: new Date().toISOString() });
  });

  app.get("/api/plans", (req, res) => {
    res.json({
      plaene: Object.entries(PLANS).map(([key, p]) => ({
        key, label: p.label, preis: p.price, anfragenProMonat: p.quota, kaufbar: Boolean(stripePriceFuer(key)),
      })),
    });
  });

  // ---------- Auth ----------
  app.post("/api/auth/registrieren", begrenze(10, 60000), (req, res) => {
    const { email, passwort, firma } = req.body || {};
    if (!emailOk(email)) return res.status(400).json({ error: "Bitte eine gueltige E-Mail-Adresse angeben" });
    if (typeof passwort !== "string" || passwort.length < 8) return res.status(400).json({ error: "Passwort braucht mindestens 8 Zeichen" });
    const vorhanden = db.prepare("SELECT id FROM users WHERE email = ?").get(email.trim());
    if (vorhanden) return res.status(409).json({ error: "Diese E-Mail ist bereits registriert" });

    const jetzt = Date.now();
    const info = db.prepare("INSERT INTO users(email, password_hash, firma, created_at) VALUES (?,?,?,?)")
      .run(email.trim().toLowerCase(), hashPasswort(passwort), (firma || "").toString().slice(0, 120), jetzt);
    const userId = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO subscriptions(user_id, plan, status, updated_at) VALUES (?,?,?,?)")
      .run(userId, "trial", "active", jetzt);
    const { token } = legeSessionAn(db, userId);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 864e5 });
    res.status(201).json({ ok: true, email: email.trim().toLowerCase() });
  });

  app.post("/api/auth/login", begrenze(10, 60000), (req, res) => {
    const { email, passwort } = req.body || {};
    const nutzer = typeof email === "string" ? db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) : null;
    if (!nutzer || !pruefePasswort(passwort || "", nutzer.password_hash)) {
      return res.status(401).json({ error: "E-Mail oder Passwort ist falsch" });
    }
    const { token } = legeSessionAn(db, nutzer.id);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 864e5 });
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  // ---------- Dashboard ----------
  app.get("/api/dashboard", mitSession, (req, res) => {
    const q = quotaFuer(db, req.nutzer.id);
    const keys = db.prepare("SELECT id, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY id DESC").all(req.nutzer.id);
    const letzte = db.prepare("SELECT eingang, antwort, kategorie, dringlichkeit, latenz_ms, created_at FROM requests_log WHERE user_id = ? ORDER BY id DESC LIMIT 10").all(req.nutzer.id);
    res.json({
      nutzer: { email: req.nutzer.email, firma: req.nutzer.firma },
      plan: { key: q.planKey, label: q.plan.label, preis: q.plan.price, quota: q.plan.quota },
      verbrauch: { verbraucht: q.verbraucht, frei: q.frei },
      keys,
      letzte,
    });
  });

  app.post("/api/dashboard/key", mitSession, (req, res) => {
    const aktiv = db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked = 0").get(req.nutzer.id).c;
    if (aktiv >= 5) return res.status(400).json({ error: "Maximal 5 aktive Schluessel pro Konto" });
    const raw = erzeugeApiKey(db, req.nutzer.id);
    res.status(201).json({ key: raw, hinweis: "Der Schluessel wird nur jetzt angezeigt. Bitte sicher speichern." });
  });

  app.post("/api/dashboard/key/:id/revoke", mitSession, (req, res) => {
    const info = db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?").run(Number(req.params.id), req.nutzer.id);
    if (!info.changes) return res.status(404).json({ error: "Schluessel nicht gefunden" });
    res.json({ ok: true });
  });

  // ---------- Kernprodukt (oeffentliche API) ----------
  async function frageBeantworten(req, res, userId, body) {
    const q = quotaFuer(db, userId);
    if (q.frei <= 0) {
      return res.status(402).json({
        error: "Monatliches Kontingent ausgeschoepft",
        plan: q.planKey,
        quota: q.plan.quota,
        upgrade: "/preise",
      });
    }
    try {
      const ergebnis = await beantworteAnfrage(body, { llm });
      verbrauche(db, userId);
      db.prepare("INSERT INTO requests_log(user_id, eingang, antwort, kategorie, dringlichkeit, provider, latenz_ms, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(userId, String(body?.nachricht || "").slice(0, 2000), ergebnis.reply, ergebnis.kategorie, ergebnis.dringlichkeit, ergebnis.provider, ergebnis.latenzMs, Date.now());
      const nachher = quotaFuer(db, userId);
      res.json({
        reply: ergebnis.reply,
        kategorie: ergebnis.kategorie,
        dringlichkeit: ergebnis.dringlichkeit,
        naechster_schritt: ergebnis.naechsterSchritt,
        meta: { provider: ergebnis.provider, latenz_ms: ergebnis.latenzMs, verbraucht: nachher.verbraucht, frei: nachher.frei },
      });
    } catch (e) {
      if (e instanceof AnfrageFehler) {
        const status = e.code === "LLM_UNAVAILABLE" ? 503 : 400;
        return res.status(status).json({ error: e.message, code: e.code });
      }
      console.error("[reply] Fehler:", e);
      res.status(502).json({ error: "Antwort konnte nicht erzeugt werden" });
    }
  }

  app.post("/api/v1/reply", begrenze(120, 60000), async (req, res) => {
    const header = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const nutzer = nutzerPerApiKey(db, header);
    if (!nutzer) return res.status(401).json({ error: "API-Schluessel fehlt oder ist ungueltig" });
    await frageBeantworten(req, res, nutzer.id, req.body);
  });

  app.post("/api/dashboard/test", mitSession, async (req, res) => {
    await frageBeantworten(req, res, req.nutzer.id, req.body);
  });

  // ---------- Oeffentlicher Sofort-Test (Lead-Magnet, ohne Anmeldung) ----------
  // Bewusst begrenzt: 3 Versuche pro IP und Tag, damit der Test nicht als
  // kostenloser Dauerzugang missbraucht wird und die Registrierung attraktiv bleibt.
  const demoZaehler = new Map();
  const DEMO_LIMIT = Number(process.env.DEMO_LIMIT || 3);

  function demoFrei(ip) {
    const heute = new Date().toISOString().slice(0, 10);
    const eintrag = demoZaehler.get(ip);
    if (!eintrag || eintrag.tag !== heute) return DEMO_LIMIT;
    return Math.max(0, DEMO_LIMIT - eintrag.anzahl);
  }

  app.get("/api/public/demo/status", (req, res) => {
    res.json({ frei: demoFrei(req.ip || "unbekannt"), limit: DEMO_LIMIT });
  });

  app.post("/api/public/demo", begrenze(6, 60000), async (req, res) => {
    const ip = req.ip || "unbekannt";
    const frei = demoFrei(ip);
    if (frei <= 0) {
      return res.status(429).json({
        error: "Der kostenlose Test ist fuer heute aufgebraucht",
        frei: 0,
        hinweis: "Mit einem kostenlosen Konto erhalten Sie 20 Anfragen.",
        registrieren: "./registrieren",
      });
    }
    try {
      const ergebnis = await beantworteAnfrage(req.body, { llm });
      const heute = new Date().toISOString().slice(0, 10);
      const eintrag = demoZaehler.get(ip);
      const anzahl = !eintrag || eintrag.tag !== heute ? 1 : eintrag.anzahl + 1;
      demoZaehler.set(ip, { tag: heute, anzahl });
      res.json({
        reply: ergebnis.reply,
        kategorie: ergebnis.kategorie,
        dringlichkeit: ergebnis.dringlichkeit,
        naechster_schritt: ergebnis.naechsterSchritt,
        meta: { frei: Math.max(0, DEMO_LIMIT - anzahl), limit: DEMO_LIMIT, latenz_ms: ergebnis.latenzMs },
      });
    } catch (e) {
      if (e instanceof AnfrageFehler) {
        return res.status(e.code === "LLM_UNAVAILABLE" ? 503 : 400).json({ error: e.message, code: e.code });
      }
      console.error("[demo] Fehler:", e);
      res.status(502).json({ error: "Antwort konnte nicht erzeugt werden" });
    }
  });

  // ---------- Billing ----------
  app.post("/api/billing/checkout", mitSession, async (req, res) => {
    const stripe = stripeClient();
    if (!stripe) return res.status(503).json({ error: "Zahlungen sind noch nicht konfiguriert (STRIPE_SECRET_KEY fehlt)" });
    try {
      const basis = process.env.BASIS_URL || `${req.protocol}://${req.get("host")}`;
      const session = await erstelleCheckout({ stripe, db, user: req.nutzer, planKey: String(req.body?.plan || ""), basisUrl: basis });
      res.json({ url: session.url });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ---------- Seiten ----------
  const seite = (datei) => {
    const inhalt = readFileSync(join(OEFFENTLICH, datei), "utf8");
    return (req, res) => { res.type("html").send(inhalt); };
  };
  app.get("/", seite("index.html"));
  app.get("/preise", seite("index.html"));
  app.get("/check", seite("check.html"));
  app.get("/login", seite("login.html"));
  app.get("/registrieren", seite("login.html"));
  app.get("/app", (req, res) => {
    if (!sessionNutzer(db, req.cookies?.[COOKIE])) return res.redirect("./login");
    res.type("html").send(readFileSync(join(OEFFENTLICH, "dashboard.html"), "utf8"));
  });

  app.use((req, res) => res.status(404).json({ error: "Nicht gefunden" }));
  return app;
}

const direktGestartet = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (direktGestartet) {
  const port = Number(process.env.PORT || 3900);
  const app = createApp();
  app.listen(port, () => console.log(`AnfragePilot laeuft auf http://127.0.0.1:${port}`));
}
