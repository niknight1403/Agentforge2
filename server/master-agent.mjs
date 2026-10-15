import { db, now } from './db.mjs';
import { createVilla } from './agents.mjs';
import { packState, setPackEnabled, TOOL_PACKS } from './packs.mjs';
import { duplicateSummary, removeDuplicates } from './villa-dedupe.mjs';

const CONNECTORS = [
  { id: 'github', title: 'GitHub', kind: 'repository', description: 'Repositories, Branches, Pull Requests und Releases' },
  { id: 'stripe', title: 'Stripe', kind: 'billing', description: 'Produkte, Preise und Monetarisierung' },
  { id: 'openai', title: 'OpenAI-kompatible LLMs', kind: 'llm', description: 'LLM-Routen und Schlüsselverwaltung' },
  { id: 'web', title: 'Web-Recherche', kind: 'research', description: 'Sichere HTTP-Recherche über das Recherche-Pack' }
];

db.exec(`
CREATE TABLE IF NOT EXISTS master_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS master_connectors (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS master_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function saveMessage(role, content, action = '') {
  db.prepare('INSERT INTO master_messages (role, content, action, created_at) VALUES (?,?,?,?)').run(role, String(content).slice(0, 12000), action, now());
}
function connectorState() {
  const rows = new Map(db.prepare('SELECT id, enabled FROM master_connectors').all().map((r) => [r.id, !!r.enabled]));
  return CONNECTORS.map((c) => ({ ...c, enabled: rows.has(c.id) ? rows.get(c.id) : true, configured: rows.has(c.id) }));
}
function state() {
  const villas = db.prepare('SELECT id, name, idea, status, mode, source_path, created_at, updated_at FROM villas ORDER BY created_at DESC').all();
  return { villas, packs: packState(), connectors: connectorState(), duplicateSummary: duplicateSummary() };
}
function reply(text, action = '', data = {}) {
  saveMessage('assistant', text, action);
  return { ok: true, answer: text, action, ...data };
}
function parseCreate(message) {
  const name = message.match(/(?:name|titel)\s*[:=]\s*([^\n,;]+)/i)?.[1]?.trim();
  const idea = message.match(/(?:idee|ziel|prompt)\s*[:=]\s*([\s\S]+)/i)?.[1]?.trim();
  if (!idea) return null;
  return { name: name || 'Master-Agent Villa', idea, agentCount: 12 };
}
function parsePack(message) {
  const match = message.match(/(?:pack|feature|skill|werkzeug)[\s:]*(?:„|"|')?([a-zäöü0-9_-]+)(?:„|"|')?\s*(?:aktivieren|einschalten|an|deaktivieren|ausschalten|aus)/i);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const pack = [...TOOL_PACKS].find((p) => p.id.toLowerCase() === raw || p.title.toLowerCase().includes(raw));
  if (!pack) return { id: raw, enabled: /aktivieren|einschalten|\ban\b/i.test(match[0]) };
  return { id: pack.id, enabled: /aktivieren|einschalten|\ban\b/i.test(match[0]) };
}

export function masterState() { return state(); }
export function masterMessages(limit = 100) {
  return db.prepare('SELECT * FROM master_messages ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 100, 1), 200)).reverse();
}
export function setConnector(id, enabled) {
  if (!CONNECTORS.some((c) => c.id === id)) return { ok: false, error: `Unbekannter Connector: ${id}` };
  db.prepare('INSERT INTO master_connectors (id, enabled, updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at').run(id, enabled ? 1 : 0, now());
  return { ok: true, connector: connectorState().find((c) => c.id === id) };
}

export async function masterChat(message, { isRunning } = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: 'message fehlt' };
  if (text.length > 8000) return { ok: false, error: 'message zu lang (max. 8000 Zeichen)' };
  saveMessage('user', text);
  const lower = text.toLowerCase();

  if (/doppelt|duplikat/.test(lower)) {
    const summary = duplicateSummary();
    const shouldApply = /bestätig|bestaetig|ja,? (löschen|loeschen|entfernen)|endgültig|endgueltig/.test(lower);
    if (shouldApply) {
      const ids = summary.groups.flatMap((g) => g.duplicates.map((v) => v.id));
      const result = removeDuplicates(ids, { isRunning });
      return reply(`${result.applied.length} doppelte Villa(n) entfernt. ${result.skipped.length} laufende Villa(n) wurden übersprungen.`, 'dedupe.apply', { result, state: state() });
    }
    return reply(summary.duplicateCount
      ? `Ich habe ${summary.duplicateCount} mögliche Duplikat(e) gefunden. Ich behalte jeweils die älteste Villa und lösche noch nichts. Wenn du fortfahren möchtest, schreibe: „Duplikate endgültig entfernen.“`
      : 'Ich habe keine doppelten Villen gefunden.', 'dedupe.preview', { summary });
  }

  const create = parseCreate(text);
  if (create && /villa|projekt|app|erstellen|bauen|anlegen/.test(lower)) {
    const result = await createVilla(create);
    return reply(`Villa „${create.name}“ wurde erstellt und für den Entwicklungs-Chat vorbereitet.`, 'villa.create', { villaId: result.villaId, state: state() });
  }

  const pack = parsePack(text);
  if (pack) {
    const out = setPackEnabled(pack.id, pack.enabled);
    if (!out.ok) return reply(out.error, 'pack.error');
    return reply(`Pack „${pack.id}“ ist jetzt ${pack.enabled ? 'aktiviert' : 'deaktiviert'}.`, 'pack.set', { pack: out, state: state() });
  }

  const connector = CONNECTORS.find((c) => lower.includes(c.id) && /(verbinden|aktivieren|deaktivieren|ausschalten|einschalten)/.test(lower));
  if (connector) {
    const enabled = !/deaktivieren|ausschalten/.test(lower);
    const out = setConnector(connector.id, enabled);
    return reply(`Connector „${connector.title}“ ist als ${enabled ? 'aktiv' : 'deaktiviert'} vorgemerkt. Zugangsdaten werden nicht im Chat gespeichert.`, 'connector.set', out);
  }

  if (/status|übersicht|uebersicht|was ist aktiv|konfiguration/.test(lower)) {
    const current = state();
    return reply(`${current.villas.length} Villen, ${current.duplicateSummary.duplicateCount} Duplikate, ${current.connectors.filter((c) => c.enabled).length} aktive Connectoren und ${current.packs.features.filter((p) => p.enabled).length} aktive Feature-Packs.`, 'state.inspect', { state: current });
  }

  return reply('Ich kann global Villen anlegen, Duplikate prüfen/bereinigen, Vorschläge abrufen sowie Feature-, Werkzeug- und Connector-Zustände verwalten. Nutze zum Anlegen: „Villa erstellen, Name: …, Idee: …“. Für eine sichere Bereinigung schreibe zuerst „Duplikate anzeigen“ und danach ausdrücklich „Duplikate endgültig entfernen.“', 'help', { state: state() });
}
