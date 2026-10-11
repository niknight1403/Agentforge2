import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.VF_DB || resolve(process.cwd(), 'server/data/villaforge.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS villas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  max_agents INTEGER NOT NULL DEFAULT 1000,
  autonomy INTEGER NOT NULL DEFAULT 1,
  route_strategy TEXT NOT NULL DEFAULT 'ROTATE',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'WORKER',
  system_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'IDLE',
  is_root INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER,
  permissions INTEGER NOT NULL DEFAULT 127,
  autonomy_level INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  agent_id INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority INTEGER NOT NULL DEFAULT 5,
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  agent_id INTEGER,
  scope TEXT NOT NULL DEFAULT 'villa',
  kind TEXT NOT NULL DEFAULT 'FACT',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  key_env TEXT NOT NULL DEFAULT '',
  is_free INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 10,
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'NEW',
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Kontingent-Kuehlzustand einzelner Keys: bei 429/402 wird ein Key kurz
-- stillgelegt und der Pool rotiert auf den naechsten (z. B. GROQ_API_KEY_2).
CREATE TABLE IF NOT EXISTS key_cool (
  name TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  villa_id INTEGER,
  agent_id INTEGER,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  allowed INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PATH',
  meta TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ANALYSIS',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

// Migrationen fuer bestehende Datenbanken: fehlende Spalten nachtragen.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('villas', 'source_path', "TEXT NOT NULL DEFAULT ''");
ensureColumn('villas', 'mode', "TEXT NOT NULL DEFAULT 'BUILD'");
// Zaehlt die selbstheilenden Runden eines Laufs. Wird beim Start eines Laufs
// zurueckgesetzt, damit die Begrenzung pro Lauf gilt und nicht pro Datenbank.
ensureColumn('villas', 'auto_rounds', 'INTEGER NOT NULL DEFAULT 0');
// Sperrzeit einer Route nach einem Fehler (Zeitstempel). Verhindert, dass jeder
// Aufruf erneut in dieselbe tote Route laeuft.
ensureColumn('routes', 'cooldown_until', 'INTEGER NOT NULL DEFAULT 0');
// Wie oft diese Aufgabe schon angelaufen ist (inkl. Selbstheilung und Retry).
// FAILED mit Versuch 3 ist eine andere Geschichte als FAILED beim ersten Versuch.
ensureColumn('tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
// Kontingent-Erschoepfung als Fehlerursache: alle echten Routen antworteten
// nur 429. Solche Aufgaben darf der Hub automatisch erneut anstossen.
ensureColumn('tasks', 'quota_blocked', 'INTEGER NOT NULL DEFAULT 0');
// Zeitstempel, zu dem der Hub einen pausierten Lauf selbst fortsetzt.
ensureColumn('villas', 'auto_retry_at', 'INTEGER NOT NULL DEFAULT 0');

export const now = () => Date.now();

/**
 * History-Rotation: Laeufe schreiben audit- und memory-Zeilen ohne Ende.
 * Nach Abschluss eines Laufs wird pro Villa auf ein handhabbares Fenster
 * gekuerzt — wichtige Erinnerungen (importance >= 8) ueberleben immer.
 * Rueckgabe: Anzahl der geloeschten Zeilen (fuer Logging/Tests).
 */
export function pruneHistory(villaId, { keepAudit = 400, keepMemories = 300 } = {}) {
  const audit = db.prepare(`
    DELETE FROM audit WHERE villa_id = ? AND id NOT IN (
      SELECT id FROM audit WHERE villa_id = ? ORDER BY id DESC LIMIT ?)`).run(villaId, villaId, keepAudit).changes;
  const mem = db.prepare(`
    DELETE FROM memories WHERE villa_id = ? AND id NOT IN (
      SELECT id FROM memories WHERE villa_id = ?
        ORDER BY (importance >= 8) DESC, importance DESC, id DESC LIMIT ?)`).run(villaId, villaId, keepMemories).changes;
  return { audit, memories: mem };
}

// Rat der Agenten (v1.11.0): Runden des agenteninternen Erfahrungsaustauschs.
// Ergebnisse fliessen zusaetzlich als Erinnerungen an alle Agenten zurueck.
db.exec(`
CREATE TABLE IF NOT EXISTS council (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  participants TEXT NOT NULL DEFAULT '',
  messages TEXT NOT NULL DEFAULT '[]',
  proposals TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`);
