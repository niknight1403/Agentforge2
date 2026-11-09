/**
 * Persoenlichkeiten und Kleidungs-Packs fuer die Darstellerinnen einer Medien-Villa.
 *
 * Warum ein eigenes Modul: Bisher gab es nur Villen, Aufgaben und Agenten. Eine
 * Medien-Villa braucht aber eine besetzbare Figur — mit Charakter, Stimme,
 * Grenzen und einem wechselbaren Kleidungs-Pack —, damit Bild- und Video-Laeufe
 * reproduzierbar dieselbe Person zeigen.
 *
 * Grundsaetze (bewusst streng, damit nichts Unbelegtes behauptet wird):
 *   - Figuren sind eigenstaendige Kunstfiguren. Es gibt keine Uebernahme realer
 *     Personen und keine geschuetzten Marken-Outfits; Namen und Rechte bleiben
 *     beim Nutzer.
 *   - Eine Figur ist erst "besetzbar", wenn Charakter (mind. 3 Merkmale), Ton,
 *     Grenzen und mindestens ein Kleidungs-Pack hinterlegt sind. Fehlende Teile
 *     werden als Luecke benannt, nicht stillschweigend ergaenzt.
 *   - Die Look-Auswahl ist deterministisch (Seed aus Figur, Anlass und Datum),
 *     damit derselbe Auftrag am selben Tag dieselbe Garderobe ergibt.
 *
 * Keine Netz-, Modell- oder Dateisystem-Zugriffe: reine Datenpflege plus
 * deterministische Auswahl.
 */
import { db } from './db.mjs';
import { now } from './db.mjs';

export const WARDROBE_SLOTS = Object.freeze([
  'top', 'bottom', 'dress', 'outerwear', 'shoes', 'hair', 'makeup', 'accessory'
]);

export const OCCASIONS = Object.freeze(['alltag', 'business', 'abend', 'sport', 'studio', 'reise']);

db.exec(`
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT,
  voice TEXT,
  languages TEXT,
  traits TEXT,
  boundaries TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wardrobe_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  occasion TEXT NOT NULL DEFAULT 'alltag',
  items TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_looks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  persona_id INTEGER NOT NULL,
  pack_id INTEGER NOT NULL,
  occasion TEXT NOT NULL,
  look_seed TEXT NOT NULL,
  resolved TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const str = (value, max = 400) => String(value ?? '').trim().slice(0, max);
const list = (value) => (Array.isArray(value) ? value : String(value ?? '').split(','))
  .map((entry) => str(entry, 120)).filter(Boolean);

function ensureVilla(villaId) {
  const id = Number(villaId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('VILLA_ID_INVALID');
  return id;
}

/** Nachweislich fehlende Teile einer Figur — Grundlage fuer den Status. */
export function personaGaps(persona, packs) {
  const gaps = [];
  if (!persona) return ['persona_fehlt'];
  if (list(persona.traits).length < 3) gaps.push('charakter_zu_duenn');
  if (!str(persona.voice)) gaps.push('stimme_fehlt');
  if (!list(persona.boundaries).length) gaps.push('grenzen_fehlen');
  if (!Array.isArray(packs) || packs.length === 0) gaps.push('kleidungs_pack_fehlt');
  return gaps;
}

export function normalizePackItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('PACK_OHNE_TEILE');
  const normalized = [];
  for (const raw of items) {
    const slot = str(raw?.slot, 24).toLowerCase();
    const description = str(raw?.description, 240);
    if (!WARDROBE_SLOTS.includes(slot)) throw new Error(`SLOT_UNBEKANNT:${slot || 'leer'}`);
    if (!description) throw new Error(`TEIL_OHNE_BESCHREIBUNG:${slot}`);
    normalized.push({
      slot,
      description,
      colors: list(raw?.colors).slice(0, 6),
      material: str(raw?.material, 80) || null
    });
  }
  // Ein vollstaendiger Look braucht etwas fuer den Oberkoerper (Top oder Kleid) und Schuhe.
  const slots = new Set(normalized.map((item) => item.slot));
  if (!slots.has('top') && !slots.has('dress')) throw new Error('LOOK_OHNE_OBERTEIL');
  if (!slots.has('shoes')) throw new Error('LOOK_OHNE_SCHUHE');
  return normalized;
}

export function createPersona(villaId, input = {}) {
  const villa = ensureVilla(villaId);
  const name = str(input.name, 120);
  if (!name) throw new Error('NAME_FEHLT');
  const ts = now();
  const info = db.prepare(`INSERT INTO personas(villa_id,name,tagline,voice,languages,traits,boundaries,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'draft',?,?)`).run(
    villa, name, str(input.tagline, 240) || null, str(input.voice, 240) || null,
    JSON.stringify(list(input.languages)), JSON.stringify(list(input.traits)),
    JSON.stringify(list(input.boundaries)), ts, ts
  );
  return personaDetail(Number(info.lastInsertRowid));
}

export function updatePersona(personaId, patch = {}) {
  const current = db.prepare('SELECT * FROM personas WHERE id=?').get(Number(personaId));
  if (!current) throw new Error('PERSONA_NICHT_GEFUNDEN');
  const next = {
    name: patch.name === undefined ? current.name : (str(patch.name, 120) || current.name),
    tagline: patch.tagline === undefined ? current.tagline : (str(patch.tagline, 240) || null),
    voice: patch.voice === undefined ? current.voice : (str(patch.voice, 240) || null),
    languages: patch.languages === undefined ? current.languages : JSON.stringify(list(patch.languages)),
    traits: patch.traits === undefined ? current.traits : JSON.stringify(list(patch.traits)),
    boundaries: patch.boundaries === undefined ? current.boundaries : JSON.stringify(list(patch.boundaries))
  };
  db.prepare('UPDATE personas SET name=?,tagline=?,voice=?,languages=?,traits=?,boundaries=?,updated_at=? WHERE id=?')
    .run(next.name, next.tagline, next.voice, next.languages, next.traits, next.boundaries, now(), current.id);
  return personaDetail(current.id);
}

const parse = (value, fallback) => {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : fallback; }
  catch { return fallback; }
};

export function personaDetail(personaId) {
  const persona = db.prepare('SELECT * FROM personas WHERE id=?').get(Number(personaId));
  if (!persona) return null;
  const packs = db.prepare('SELECT * FROM wardrobe_packs WHERE persona_id=? ORDER BY created_at').all(persona.id)
    .map((pack) => ({ ...pack, items: parse(pack.items, []) }));
  const shaped = {
    ...persona,
    traits: parse(persona.traits, []),
    boundaries: parse(persona.boundaries, []),
    languages: parse(persona.languages, [])
  };
  const gaps = personaGaps(shaped, packs);
  return { ...shaped, packs, gaps, castable: gaps.length === 0, status: gaps.length ? 'draft' : 'castable' };
}

export function listPersonas(villaId) {
  const rows = db.prepare('SELECT id FROM personas WHERE villa_id=? ORDER BY created_at').all(ensureVilla(villaId));
  return rows.map((row) => personaDetail(row.id));
}

export function createWardrobePack(personaId, input = {}) {
  const persona = db.prepare('SELECT * FROM personas WHERE id=?').get(Number(personaId));
  if (!persona) throw new Error('PERSONA_NICHT_GEFUNDEN');
  const name = str(input.name, 120);
  if (!name) throw new Error('PACK_NAME_FEHLT');
  const occasion = str(input.occasion, 24).toLowerCase() || 'alltag';
  if (!OCCASIONS.includes(occasion)) throw new Error(`ANLASS_UNBEKANNT:${occasion}`);
  const items = normalizePackItems(input.items);
  const ts = now();
  const info = db.prepare(`INSERT INTO wardrobe_packs(persona_id,name,occasion,items,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(persona.id, name, occasion, JSON.stringify(items), str(input.notes, 400) || null, ts, ts);
  db.prepare("UPDATE personas SET status='castable',updated_at=? WHERE id=?").run(ts, persona.id);
  return { id: Number(info.lastInsertRowid), personaId: persona.id, name, occasion, items };
}

export function listWardrobePacks(personaId) {
  return db.prepare('SELECT * FROM wardrobe_packs WHERE persona_id=? ORDER BY created_at').all(Number(personaId))
    .map((pack) => ({ ...pack, items: parse(pack.items, []) }));
}

/** Stabiler Hash: gleicher Auftrag am gleichen Tag ergibt dieselbe Garderobe. */
export function lookSeed(parts) {
  const text = parts.filter(Boolean).join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Waehlt das Kleidungs-Pack fuer einen Anlass.
 * Reihenfolge: exakter Anlass, dann 'alltag', dann irgendein Pack. Kein Pack
 * bedeutet: ehrlich `null` mit Grund, nicht ein erfundenes Outfit.
 */
export function resolveLook(personaId, { occasion = 'alltag', day = null } = {}) {
  const persona = personaDetail(personaId);
  if (!persona) throw new Error('PERSONA_NICHT_GEFUNDEN');
  if (!persona.packs.length) return { ok: false, reason: 'kein_kleidungs_pack', personaId: persona.id };
  const wanted = OCCASIONS.includes(String(occasion)) ? String(occasion) : 'alltag';
  const candidates = persona.packs.filter((pack) => pack.occasion === wanted);
  const pool = candidates.length ? candidates : persona.packs.filter((pack) => pack.occasion === 'alltag');
  const chosen = (pool.length ? pool : persona.packs)[0];
  const stamp = day || new Date().toISOString().slice(0, 10);
  const seed = lookSeed([persona.id, chosen.id, wanted, stamp]);
  const resolved = {
    persona: persona.name,
    occasion: wanted,
    pack: chosen.name,
    items: chosen.items,
    note: candidates.length ? null : 'kein_pack_fuer_anlass_genommen_standard'
  };
  db.prepare(`INSERT INTO persona_looks(villa_id,persona_id,pack_id,occasion,look_seed,resolved,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(persona.villa_id, persona.id, chosen.id, wanted, seed, JSON.stringify(resolved), now());
  return { ok: true, seed, ...resolved };
}

/** Kompakte Karte, die Bild-/Video-Laeufe als Figurenbeschreibung erhalten. */
export function personaCard(personaId) {
  const persona = personaDetail(personaId);
  if (!persona) throw new Error('PERSONA_NICHT_GEFUNDEN');
  return {
    id: persona.id,
    name: persona.name,
    tagline: persona.tagline,
    voice: persona.voice,
    traits: persona.traits,
    boundaries: persona.boundaries,
    languages: persona.languages,
    castable: persona.castable,
    gaps: persona.gaps,
    packs: persona.packs.map((pack) => ({ id: pack.id, name: pack.name, occasion: pack.occasion, slots: pack.items.map((item) => item.slot) }))
  };
}

export function castOverview(villaId) {
  const personas = listPersonas(villaId);
  return {
    villaId: Number(villaId),
    total: personas.length,
    castable: personas.filter((persona) => persona.castable).length,
    personas: personas.map((persona) => ({
      id: persona.id, name: persona.name, status: persona.status, gaps: persona.gaps, packs: persona.packs.length
    }))
  };
}
