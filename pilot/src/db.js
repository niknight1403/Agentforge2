import Database from "better-sqlite3";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Datenbank-Schicht fuer AnfragePilot.
 *
 * Bewusst SQLite (eine Datei, kein Extra-Dienst): der Pilot laeuft damit auf
 * jeder VM ohne Provisioning. Alle Zugriffe laufen ueber diese Datei, damit ein
 * spaeterer Wechsel auf Postgres nur hier erfolgen muss.
 */

export const PLANS = {
  trial: { label: "Testphase", price: 0, quota: 20, stripePrice: null },
  starter: { label: "Starter", price: 49, quota: 200 },
  pro: { label: "Pro", price: 99, quota: 1000 },
  business: { label: "Business", price: 199, quota: 5000 },
};

export function openDatabase(file = process.env.DB_FILE || "data/anfragepilot.db") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      firma TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'trial',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer TEXT,
      stripe_subscription TEXT,
      current_period_end INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      monat TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_monat ON usage_events(user_id, monat);

    CREATE TABLE IF NOT EXISTS requests_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      eingang TEXT NOT NULL,
      antwort TEXT NOT NULL,
      kategorie TEXT,
      dringlichkeit TEXT,
      provider TEXT,
      latenz_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY,
      typ TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/**
 * Preis-ID eines Plans. Wird bewusst zur Laufzeit aus der Umgebung gelesen,
 * damit Konfigurationsaenderungen ohne Neustart des Prozesses greifen.
 */
export function stripePriceFuer(planKey) {
  return process.env[`STRIPE_PRICE_${String(planKey).toUpperCase()}`] || null;
}

export function monatJetzt(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export function neueApiKey() {
  const raw = "ap_" + randomBytes(24).toString("base64url");
  return { raw, prefix: raw.slice(0, 10), hash: hashKey(raw) };
}

export function neueSession() {
  return randomBytes(32).toString("base64url");
}

export function quotaFuer(db, userId) {
  const sub = db.prepare("SELECT plan, status FROM subscriptions WHERE user_id = ?").get(userId);
  const planKey = sub && sub.status === "active" ? sub.plan : "trial";
  const plan = PLANS[planKey] || PLANS.trial;
  const verbraucht = db
    .prepare("SELECT COUNT(*) AS c FROM usage_events WHERE user_id = ? AND monat = ?")
    .get(userId, monatJetzt()).c;
  return { planKey, plan, verbraucht, frei: Math.max(0, plan.quota - verbraucht) };
}

export function verbrauche(db, userId) {
  db.prepare("INSERT INTO usage_events(user_id, monat, created_at) VALUES (?,?,?)")
    .run(userId, monatJetzt(), Date.now());
}
