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

function getVilla(id) {
  const v = db.prepare('SELECT id, name, idea, status FROM villas WHERE id = ?').get(id);
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
 * Regelbasierte Erzeugung von 3 Monetarisierungs-Vorschlägen (Revenue-Light).
 */
export function generateOfflineRevenueIdeas(villa) {
  const name = villa.name || 'Projekt';

  return [
    {
      name: `${name} - API & Developer Subscription`,
      price_eur: 29.00,
      steps: [
        `1. REST-API für ${name} mit Auth-Keys und Rate-Limiting absichern`,
        `2. Stripe Checkout für monatliches API-Abo (29 EUR/Monat) anbinden`,
        `3. Entwickler-Dokumentation & Self-Service Portal bereitstellen`
      ],
      source: 'offline'
    },
    {
      name: `${name} - Enterprise Custom Solution`,
      price_eur: 499.00,
      steps: [
        `1. Dedizierte Hosting-Pakete und Custom SLAs definieren`,
        `2. Nahtlose Anbindung an bestehende Enterprise-Systeme anbieten`,
        `3. B2B Vertriebskanal & Demo-Terminbuchung auf der Website einrichten`
      ],
      source: 'offline'
    },
    {
      name: `${name} - Pay-per-Use Credits`,
      price_eur: 9.90,
      steps: [
        `1. Mikrozahlungen für verbrauchsbasierte Abrechnung implementieren`,
        `2. Guthaben-Verwaltung & automatisches Refill-System verankern`,
        `3. Startguthaben-Aktion zur Neukunden-Konvertierung starten`
      ],
      source: 'offline'
    }
  ];
}

/**
 * Liefert 3 Monetarisierungs-Vorschläge für eine Villa (Revenue-Light).
 * Speichert sie in `revenue_ideas` falls noch nicht vorhanden.
 */
export function getVillaRevenue(villaId) {
  const villa = getVilla(villaId);

  // Prüfen ob bereits Ideen existieren
  const existing = db.prepare('SELECT id, villa_id, name, price_eur, steps, source, created_at FROM revenue_ideas WHERE villa_id = ? ORDER BY id ASC').all(villa.id);

  if (existing.length >= 3) {
    const formatted = existing.map((row) => ({
      id: Number(row.id),
      villa_id: Number(row.villa_id),
      name: row.name,
      price_eur: Number(row.price_eur),
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps,
      source: row.source || 'offline',
      created_at: Number(row.created_at)
    }));
    return {
      ok: true,
      villaId: villa.id,
      ideas: formatted,
      count: formatted.length,
      source: 'offline'
    };
  }

  // Generieren & Speichern
  const rawIdeas = generateOfflineRevenueIdeas(villa);
  const timestamp = now();
  const savedIdeas = [];

  const stmt = db.prepare('INSERT INTO revenue_ideas (villa_id, name, price_eur, steps, source, created_at) VALUES (?, ?, ?, ?, ?, ?)');

  for (const idea of rawIdeas) {
    const stepsJson = JSON.stringify(idea.steps);
    const res = stmt.run(villa.id, idea.name, idea.price_eur, stepsJson, 'offline', timestamp);
    const ideaId = Number(res.lastInsertRowid);
    savedIdeas.push({
      id: ideaId,
      villa_id: villa.id,
      name: idea.name,
      price_eur: idea.price_eur,
      steps: idea.steps,
      source: 'offline',
      created_at: timestamp
    });
  }

  return {
    ok: true,
    villaId: villa.id,
    ideas: savedIdeas,
    count: savedIdeas.length,
    source: 'offline'
  };
}
