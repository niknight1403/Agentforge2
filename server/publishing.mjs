import { db, now } from './db.mjs';

// Table migrations for Publishing Sandbox and Revenue-Light
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    villa_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'SANDBOX',
    created_at INTEGER NOT NULL
  )
`);
try { db.exec("ALTER TABLE posts ADD COLUMN state TEXT NOT NULL DEFAULT 'SANDBOX'"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN created_at INTEGER"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    villa_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price_eur REAL NOT NULL,
    steps TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'offline',
    created_at INTEGER NOT NULL
  )
`);
try { db.exec("ALTER TABLE revenue_ideas ADD COLUMN source TEXT NOT NULL DEFAULT 'offline'"); } catch {}
try { db.exec("ALTER TABLE revenue_ideas ADD COLUMN created_at INTEGER"); } catch {}
// Sprint 8b: Vorschlaege haengen jetzt an der Villen-IDE, nicht nur am Namen.
// Bei geaenderter Idee werden die Vorschlaege neu erzeugt (Hash-Vergleich).
try { db.exec("ALTER TABLE revenue_ideas ADD COLUMN idea_hash TEXT"); } catch {}

function getVilla(id) {
  const villaId = Number(id);
  if (!Number.isInteger(villaId) || villaId <= 0) {
    const err = new Error('Villa nicht gefunden');
    err.statusCode = 404;
    throw err;
  }
  const v = db.prepare('SELECT id, name, idea, status FROM villas WHERE id = ?').get(villaId);
  if (!v) {
    const err = new Error('Villa nicht gefunden');
    err.statusCode = 404;
    throw err;
  }
  return v;
}

/**
 * Erzeugt einen oder mehrere Posts im strikten SANDBOX-Modus.
 */
export function createPublishPost(villaId, payload = {}) {
  const villa = getVilla(villaId);
  const text = String(payload.text || '').trim();
  if (!text) {
    const err = new Error('Text für Social-Media-Post erforderlich');
    err.statusCode = 400;
    throw err;
  }

  let platforms = [];
  if (Array.isArray(payload.platforms) && payload.platforms.length > 0) {
    platforms = payload.platforms.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  } else if (payload.platform) {
    platforms = [String(payload.platform).trim().toLowerCase()];
  } else {
    platforms = ['x'];
  }

  const timestamp = now();
  const createdPosts = [];

  const stmt = db.prepare('INSERT INTO posts (villa_id, platform, text, state, created_at) VALUES (?, ?, ?, ?, ?)');

  for (const platform of platforms) {
    const res = stmt.run(villa.id, platform, text, 'SANDBOX', timestamp);
    const postId = Number(res.lastInsertRowid);
    createdPosts.push({
      id: postId,
      villa_id: villa.id,
      platform,
      text,
      state: 'SANDBOX',
      created_at: timestamp
    });
  }

  return {
    ok: true,
    sandbox: true,
    hint: 'Strikter SANDBOX-Modus: Keine Plattform-Tokens im Hub konfiguriert. Postings wurden als SANDBOX-Einträge gespeichert.',
    posts: createdPosts
  };
}

/**
 * Listet alle Veröffentlichungen / Postings einer Villa.
 */
export function listPublishPosts(villaId) {
  const villa = getVilla(villaId);
  const posts = db.prepare('SELECT id, villa_id, platform, text, state, created_at FROM posts WHERE villa_id = ? ORDER BY id DESC').all(villa.id);

  return {
    ok: true,
    villaId: villa.id,
    sandbox: true,
    hint: 'Strikter SANDBOX-Modus aktiv.',
    posts
  };
}

/**
 * Regelbasierte Kategorisierung der Villen-Idee (Stil: buildOfflineAnswer in llm.mjs —
 * reine Stichwort-Heuristik, kein LLM, kein Netz).
 */
const REVENUE_CATALOG = [
  {
    id: 'api',
    match: /api|sdk|saas|plattform|platform|backend|server|infrastruktur|infrastructure|datenbank|database|automatis|automation|agent/i,
    name: (n) => `${n} API-Zugang (Developer-Abo)`,
    price_eur: 29,
    steps: (n) => [
      `1. Kernfunktionen von ${n} als dokumentierte REST-API mit API-Keys und Rate-Limits bereitstellen`,
      `2. Stripe-Abo (29 EUR/Monat) mit Nutzungs-Limits und Self-Service-Portal anbinden`,
      `3. Quickstart-Doku plus Beispiel-Client veroeffentlichen und erste 10 Entwickler direkt ansprechen`
    ]
  },
  {
    id: 'service',
    match: /studio|agentur|beratung|consult|service|support|betreuung|coaching|management|marketing|vertrieb/i,
    name: (n) => `${n} Done-for-you Paket`,
    price_eur: 499,
    steps: () => [
      '1. Ein klar umrissenes Ergebnis-Paket (Scope, Lieferzeit, Deliverables) auf einer Preisseite fixieren',
      '2. Einen Referenz-Durchlauf kostenlos oder stark reduziert durchfuehren und als Case Study dokumentieren',
      '3. Buchungs-Link plus 3 Ansprache-Vorlagen fuer Direktakquise aufsetzen und 20 Kontakte anschreiben'
    ]
  },
  {
    id: 'digital',
    match: /kurs|course|tutorial|leitfaden|guide|ebook|buch|vorlage|template|workshop|schulung|lernen|learn|wissen/i,
    name: (n) => `${n} Selbstlern-Kurs`,
    price_eur: 49,
    steps: () => [
      '1. Die 5 haeufigsten Fragen der Zielgruppe als Modul-Gliederung festhalten',
      '2. Module als kurze Videos plus Checklisten produzieren und auf einer Verkaufsseite buendeln',
      '3. Fruehbucher-Aktion (49 EUR statt 89 EUR) an die eigene Kontaktliste und 2 Communities ausspielen'
    ]
  },
  {
    id: 'marketplace',
    match: /marktplatz|marketplace|shop|store|handel|verkauf|reseller|affiliate|produkt|product/i,
    name: (n) => `${n} Provision pro Vermittlung`,
    price_eur: 19,
    steps: () => [
      '1. Angebots-Seite mit den 10 besten Partnern und klaren Preisen aufbauen',
      '2. Tracking-Links und Cookie-Fenster je Partner einrichten, Provisionen schriftlich bestaetigen',
      '3. Woechentlich einen Vergleichs- oder Bestenlisten-Beitrag veroeffentlichen, um Suchtraffic zu holen'
    ]
  },
  {
    id: 'community',
    match: /community|podcast|youtube|newsletter|blog|content|social|forum|discord|stream|audio|video|musik|music/i,
    name: (n) => `${n} Mitgliedschaft`,
    price_eur: 9.9,
    steps: () => [
      '1. Ein woechentliches Premium-Format (Analyse, Live-Session oder Download) festlegen',
      '2. Bezahl-Mitgliedschaft mit 9,90 EUR/Monat ueber Stripe oder Steady aufsetzen',
      '3. Eine kostenlose Vorschau-Version veroeffentlichen und auf die Mitgliedschaft verlinken'
    ]
  },
  {
    id: 'hardware',
    match: /hardware|geraet|device|3d|druck|print|bau|fertigung|sensor|robot/i,
    name: (n) => `${n} Bausatz plus Anleitung`,
    price_eur: 89,
    steps: () => [
      '1. Stueckliste und Bezugsquellen festlegen und ein Vorserien-Exemplar bauen',
      '2. Bausatz mit bebilderter Anleitung als Kleinserie (89 EUR) kalkulieren und Vorbestellungen sammeln',
      '3. Erst nach erreichter Mindestbestellmenge produzieren, um Lagerrisiko zu vermeiden'
    ]
  }
];

const DEFAULT_CATALOG_ENTRY = {
  id: 'paid-tool',
  name: (n) => `${n} Pro-Version`,
  price_eur: 19,
  steps: (n) => [
    `1. Die 3 wertvollsten Funktionen von ${n} herausarbeiten und hinter eine Free-Limit-Grenze legen`,
    '2. Bezahl-Freischaltung (19 EUR/Monat oder Einmalkauf) mit Stripe-Checkout anbinden',
    '3. Upgrade-Hinweis an der Limit-Grenze einblenden und 10 Bestandsnutzer direkt auf den Mehrwert ansprechen'
  ]
};

/** Waehlt 3 Katalog-Eintraege anhand der Villen-Idee (deterministisch). */
function classifyRevenueCatalog(villa) {
  const haystack = `${villa.name || ''} ${villa.idea || ''}`.toLowerCase();
  const hits = REVENUE_CATALOG.filter((e) => e.match.test(haystack));
  const chosen = [...hits];
  // Mit generischen Verdienmodellen auffuellen, damit immer 3 Vorschlaege entstehen.
  const fillers = [
    REVENUE_CATALOG.find((e) => e.id === 'api'),
    REVENUE_CATALOG.find((e) => e.id === 'service'),
    REVENUE_CATALOG.find((e) => e.id === 'community')
  ];
  for (const f of fillers) {
    if (chosen.length >= 3) break;
    if (f && !chosen.includes(f)) chosen.push(f);
  }
  while (chosen.length < 3) chosen.push(DEFAULT_CATALOG_ENTRY);
  return chosen.slice(0, 3);
}

/** Stabiler Hash ueber Name + Idee: aendert sich die Idee, werden Vorschlaege neu erzeugt. */
function ideaFingerprint(villa) {
  const raw = `${villa.name || ''}\u0000${villa.idea || ''}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i += 1) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return `v1:${h.toString(16)}:${raw.length}`;
}

/**
 * Regelbasierte Erzeugung von 3 Monetarisierungs-Vorschlaegen aus der Villen-Idee.
 */
export function generateOfflineRevenueIdeas(villa) {
  const name = String(villa.name || 'Projekt').trim() || 'Projekt';
  return classifyRevenueCatalog(villa).map((entry) => ({
    name: entry.name(name),
    price_eur: entry.price_eur,
    steps: entry.steps(name),
    source: 'offline'
  }));
}

/**
 * Liefert 3 Monetarisierungs-Vorschläge für eine Villa (Revenue-Light).
 * Speichert sie in `revenue_ideas` falls noch nicht vorhanden.
 */
export function getVillaRevenue(villaId) {
  const villa = getVilla(villaId);
  const fingerprint = ideaFingerprint(villa);

  const readRows = () => db
    .prepare('SELECT id, villa_id, name, price_eur, steps, source, created_at FROM revenue_ideas WHERE villa_id = ? ORDER BY id ASC')
    .all(villa.id);

  const format = (rows) => rows.map((row) => ({
    id: Number(row.id),
    villa_id: Number(row.villa_id),
    name: row.name,
    price_eur: Number(row.price_eur),
    steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps,
    source: row.source || 'offline',
    created_at: Number(row.created_at)
  }));

  // Bereits erzeugte Vorschlaege werden nur wiederverwendet, solange die Idee gleich blieb.
  const stored = db
    .prepare('SELECT idea_hash FROM revenue_ideas WHERE villa_id = ? ORDER BY id ASC')
    .all(villa.id);
  const matching = stored.length >= 3 && stored.every((r) => r.idea_hash === fingerprint);

  if (matching) {
    const formatted = format(readRows());
    return { ok: true, villaId: villa.id, ideas: formatted, count: formatted.length, source: 'offline' };
  }

  const rawIdeas = generateOfflineRevenueIdeas(villa);
  const timestamp = now();
  const savedIdeas = [];

  db.prepare('DELETE FROM revenue_ideas WHERE villa_id = ?').run(villa.id);
  const stmt = db.prepare('INSERT INTO revenue_ideas (villa_id, name, price_eur, steps, source, created_at, idea_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');

  for (const idea of rawIdeas) {
    const res = stmt.run(villa.id, idea.name, idea.price_eur, JSON.stringify(idea.steps), 'offline', timestamp, fingerprint);
    savedIdeas.push({
      id: Number(res.lastInsertRowid),
      villa_id: villa.id,
      name: idea.name,
      price_eur: idea.price_eur,
      steps: idea.steps,
      source: 'offline',
      created_at: timestamp
    });
  }

  return { ok: true, villaId: villa.id, ideas: savedIdeas, count: savedIdeas.length, source: 'offline' };
}
