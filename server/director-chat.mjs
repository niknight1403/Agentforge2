/**
 * Manueller Steuerungs-Chat fuer die Darstellerinnen einer Medien-Villa.
 *
 * Der Chat ist die Regie: eine Anweisung ("zieh das Business-Pack an", "Szene:
 * Kueche am Morgen", "spiel ruhiger") wird als typisierte Anweisung gespeichert
 * und beim naechsten Bild-/Video-Lauf von der Produktion abgeholt. Damit ist
 * klar, was angekommen ist und was tatsaechlich angewandt wurde.
 *
 * Ehrlichkeitsregel: Eine Anweisung ist mit dem Speichern NICHT umgesetzt. Der
 * Status bleibt `offen`, bis ein Render-/Produktionsschritt sie abholt
 * (`consumeDirections`). Der Chat behauptet nie, ein Bild oder Video sei fertig.
 *
 * Die Erkennung ist bewusst deterministisch (Stichwort + Reihenfolge), damit sie
 * ohne Modell und ohne Netz funktioniert. Ein Sprachmodell kann spaeter ergaenzen,
 * aber nicht noetig sein.
 */
import { db, now } from './db.mjs';

export const DIRECTION_KINDS = Object.freeze([
  'outfit', 'scene', 'tone', 'schedule', 'pause', 'resume', 'persona', 'prop', 'no_go'
]);

db.exec(`
CREATE TABLE IF NOT EXISTS director_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  persona_id INTEGER,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  intent TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS director_directions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  persona_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'offen',
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
`);

const str = (value, max = 600) => String(value ?? '').trim().slice(0, max);
const json = (value) => JSON.stringify(value ?? null);
const parse = (value) => { try { return value ? JSON.parse(value) : null; } catch { return null; } };

const PATTERNS = [
  // Reihenfolge = Vorrang. Negative Anweisungen schlagen positive ("trag keine ..."),
  // Szenenbegriffe schlagen Zeitangaben ("Szene: Kueche am Morgen").
  { kind: 'pause', re: /\b(stopp?|pause|halt|pausiere|unterbrich)\b/i },
  { kind: 'resume', re: /\b(weiter|fortsetzen|weitermachen|resume)\b/i },
  { kind: 'no_go', re: /\b(nicht|vermeide|kein|keine|tabu|niemals)\b/i },
  { kind: 'outfit', re: /\b(outfit|kleid(?:ung)?|zieh|anziehen|trag(?:e)?|garderobe|pack)\b/i },
  { kind: 'scene', re: /\b(szene|location|kulisse|setting|kamera|aufnahme|shooting)\b/i },
  { kind: 'schedule', re: /\b(morgen|heute|um\s?\d|uhr|dreh(?:en)?|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|naechste woche)\b/i },
  { kind: 'prop', re: /\b(requisite|accessoire|halte|hält|buch|kaffee|tasse|tasche)\b/i },
  { kind: 'tone', re: /\b(stimmung|ton|ruhig\w*|energi\w*|frech\w*|sachlich\w*|(?:warm|waerm)\w*|humor\w*|ernst\w*)\b/i },
  { kind: 'persona', re: /\b(als\s+\w+|figur|rolle|darstellerin)\b/i }
];

/** Erkennt die Anweisungsart. Reine Funktion, gut testbar. */
export function classifyDirection(text) {
  const clean = str(text);
  if (!clean) return { kind: null, reason: 'leer' };
  for (const pattern of PATTERNS) {
    if (pattern.re.test(clean)) {
      return { kind: pattern.kind, reason: `stichwort:${pattern.kind}` };
    }
  }
  return { kind: null, reason: 'kein_stichwort' };
}

function ensureIds(villaId, personaId) {
  const villa = Number(villaId);
  if (!Number.isInteger(villa) || villa <= 0) throw new Error('VILLA_ID_INVALID');
  const persona = personaId === null || personaId === undefined ? null : Number(personaId);
  if (persona !== null && (!Number.isInteger(persona) || persona <= 0)) throw new Error('PERSONA_ID_INVALID');
  return { villa, persona };
}

/**
 * Nimmt eine Regieanweisung auf. Gibt ehrlich zurueck, ob sie als Anweisung
 * erkannt wurde und dass sie noch nicht angewandt ist.
 */
export function postInstruction(villaId, personaId, text, { role = 'user' } = {}) {
  const { villa, persona } = ensureIds(villaId, personaId);
  const clean = str(text, 2000);
  if (!clean) throw new Error('ANWEISUNG_LEER');
  const classified = classifyDirection(clean);
  const ts = now();
  db.prepare('INSERT INTO director_messages(villa_id,persona_id,role,text,intent,payload,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(villa, persona, str(role, 16) || 'user', clean, classified.kind, json({ reason: classified.reason }), ts);

  if (!classified.kind) {
    return {
      recorded: true,
      applied: false,
      direction: null,
      note: 'Als Nachricht gespeichert, aber keine ausfuehrbare Anweisung erkannt (kein Stichwort fuer Outfit, Szene, Ton, Zeit, Pause, Rolle, Requisite).'
    };
  }

  const info = db.prepare(`INSERT INTO director_directions(villa_id,persona_id,kind,text,payload,status,created_at)
    VALUES (?,?,?,?,?,'offen',?)`).run(villa, persona, classified.kind, clean, json({ reason: classified.reason }), ts);
  return {
    recorded: true,
    applied: false,
    direction: { id: Number(info.lastInsertRowid), kind: classified.kind, text: clean, status: 'offen' },
    note: 'Anweisung gespeichert. Sie wird beim naechsten Produktionslauf abgeholt; erst dann gilt sie als angewandt.'
  };
}

/** Offene Anweisungen, die die Produktion als Regie-Vorgaben liest. */
export function activeDirections(villaId, personaId = null) {
  const { villa, persona } = ensureIds(villaId, personaId);
  const rows = persona === null
    ? db.prepare("SELECT * FROM director_directions WHERE villa_id=? AND status='offen' ORDER BY created_at").all(villa)
    : db.prepare("SELECT * FROM director_directions WHERE villa_id=? AND (persona_id IS ? OR persona_id IS NULL) AND status='offen' ORDER BY created_at").all(villa, persona);
  return rows.map((row) => ({ ...row, payload: parse(row.payload) }));
}

/**
 * Holt Anweisungen fuer einen konkreten Lauf ab und markiert sie als angewandt.
 * Nur dieser Schritt darf `applied` behaupten — und auch nur fuer die Arten, die
 * der Lauf wirklich verarbeitet hat (`kinds`).
 */
export function consumeDirections(villaId, personaId, kinds = DIRECTION_KINDS, { note = null } = {}) {
  const { villa, persona } = ensureIds(villaId, personaId);
  const wanted = (Array.isArray(kinds) ? kinds : [kinds]).filter((kind) => DIRECTION_KINDS.includes(kind));
  if (!wanted.length) return { applied: [], skipped: 'keine_gueltige_art' };
  const placeholders = wanted.map(() => '?').join(',');
  const rows = persona === null
    ? db.prepare(`SELECT * FROM director_directions WHERE villa_id=? AND status='offen' AND kind IN (${placeholders}) ORDER BY created_at`).all(villa, ...wanted)
    : db.prepare(`SELECT * FROM director_directions WHERE villa_id=? AND (persona_id IS ? OR persona_id IS NULL) AND status='offen' AND kind IN (${placeholders}) ORDER BY created_at`).all(villa, persona, ...wanted);
  const ts = now();
  for (const row of rows) {
    db.prepare("UPDATE director_directions SET status='angewandt',applied_at=? WHERE id=?").run(ts, row.id);
  }
  return {
    applied: rows.map((row) => ({ id: row.id, kind: row.kind, text: row.text, payload: parse(row.payload) })),
    note: note || (rows.length ? 'Anweisungen wurden in diesem Lauf uebernommen.' : 'Keine offenen Anweisungen fuer diesen Lauf.')
  };
}

export function directorHistory(villaId, personaId = null, limit = 50) {
  const { villa, persona } = ensureIds(villaId, personaId);
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  const rows = persona === null
    ? db.prepare('SELECT * FROM director_messages WHERE villa_id=? ORDER BY created_at DESC LIMIT ?').all(villa, capped)
    : db.prepare('SELECT * FROM director_messages WHERE villa_id=? AND (persona_id IS ? OR persona_id IS NULL) ORDER BY created_at DESC LIMIT ?').all(villa, persona, capped);
  return rows.reverse().map((row) => ({ ...row, payload: parse(row.payload) }));
}

/** Kurzbericht: was wartet noch auf einen Lauf, was wurde schon uebernommen. */
export function directorStatus(villaId, personaId = null) {
  const { villa } = ensureIds(villaId, personaId);
  const counts = db.prepare(`SELECT status, kind, COUNT(*) n FROM director_directions WHERE villa_id=? GROUP BY status, kind`).all(villa);
  const byStatus = { offen: 0, angewandt: 0 };
  const byKind = {};
  for (const row of counts) {
    if (byStatus[row.status] !== undefined) byStatus[row.status] += Number(row.n);
    byKind[row.kind] = (byKind[row.kind] || 0) + Number(row.n);
  }
  return {
    villaId: villa,
    open: byStatus.offen,
    applied: byStatus.angewandt,
    byKind,
    note: 'Offene Anweisungen sind noch nicht umgesetzt; sie werden beim naechsten Produktionslauf uebernommen.'
  };
}
