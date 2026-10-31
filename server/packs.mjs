/**
 * Feature- und Werkzeug-Packs — eine Wahrheit fuer Hub, Web-UI und Android-App.
 *
 * Warum serverseitig: Die App hatte ihre Pack-Liste fest im Kotlin-Code
 * (FeaturePacks.kt), der Hub kannte sie gar nicht. Damit konnte niemand sagen,
 * was ein Pack im Betrieb wirklich abschaltet. Hier steht jetzt beides
 * zusammen — Feature-Packs (was die Oberflaeche zeigt) und Werkzeug-Packs
 * (was die Agenten benutzen duerfen). Ein Pack ist keine Anzeige-Deko:
 * ist sein Werkzeug-Pack aus, blockiert der Hub die Werkzeuge im Lauf und
 * protokolliert das im Audit als "blockiert".
 */
import { db, now } from './db.mjs';
import { toolEnabled } from './control-store.mjs';

/** Reihenfolge = Anzeigereihenfolge in Weboberflaeche und App. */
export const FEATURE_PACKS = [
  {
    id: 'monitoring',
    title: 'Monitoring Pack',
    description: 'Hub-Gesundheit, Routen-Status, CPU/GPU/RAM-Messwerte, Parallelitätsempfehlung und Live-Kennzahlen im Dashboard.',
    caps: ['/api/health', '/api/stats', '/api/resources', '/api/resources/history', '/api/free-routes']
  },
  {
    id: 'analytics',
    title: 'Analytics Pack',
    description: 'Aufgaben- und Agenten-Fortschritt als Kennzahlen und Verlauf.',
    caps: ['/api/stats']
  },
  {
    id: 'council',
    title: 'Rat der Agenten',
    description: 'Agenten tauschen Erkenntnisse aus, optimieren die Villa gemeinsam und teilen Vorschlaege.',
    caps: ['/api/villas/:id/council']
  },
  {
    id: 'product',
    title: 'Produkt- & Marktreife-Pack',
    description: 'Marktreife-Score als animierter Ring, Phasen-Fortschritt und Produktwellen je Villa im Detail-Screen.',
    caps: ['/api/villas/:id/product']
  },
  {
    id: 'superintelligence',
    title: 'Superintelligenz-Loop',
    description: 'Der Hub beruft den Rat automatisch alle 2 Stunden ein — die Villa optimiert sich fortlaufend selbst.',
    caps: ['/api/villas/:id/council']
  },
  {
    id: 'qualitaetstor',
    title: 'Echter-Code-Qualitaetstor',
    description: 'Code-Aufgaben muessen den Build/Test-Tor des echten Projekts passieren, bevor sie als erledigt gelten — nicht bestanden bleibt offen, bis die Prüfung besteht.',
    caps: []
  },
  {
    id: 'reflexion',
    title: 'Reflexions-Loop',
    description: 'Agenten pruefen und verbessern ihre eigene Antwort mit einem zweiten Modellauf, bevor sie abgeschlossen wird.',
    caps: []
  },
  {
    id: 'werkzeuge',
    title: 'Werkzeug-Pack (Hauptschalter)',
    description: 'Schaltet alle Werkzeug-Packs frei oder sperrt sie. Aus = Agenten planen, aber arbeiten nicht am Projekt.',
    caps: ['/api/tools', '/api/tool-packs']
  },
  {
    id: 'routen',
    title: 'Routen-Pack',
    description: 'LLM-Routen und Schluessel verwalten, Kontingente rotieren und Route-Gesundheit beobachten.',
    caps: ['/api/routes', '/api/secrets']
  },
  {
    id: 'memory',
    title: 'Gedaechtnis-Pack',
    description: 'Villa-Gedaechtnis durchsuchen und fortschreiben.',
    caps: ['/api/villas/:id']
  },
  {
    id: 'wartung',
    title: 'Wartungs-Pack',
    description: 'Backup ziehen, Protokolle aufraeumen, Villen exportieren und importieren.',
    caps: ['/api/backup', '/api/maintenance/prune']
  }
];

/** Der Hauptschalter: ohne dieses Feature-Pack laeuft kein Werkzeug. */
export const MASTER_PACK = 'werkzeuge';

/** Werkzeuge nach Aufgabe gebuendelt — genau so, wie Agenten sie brauchen. */
export const TOOL_PACKS = [
  { id: 'gedaechtnis', title: 'Gedaechtnis', description: 'Wissen sichern und wiederfinden.', tools: ['memory_write', 'memory_search'] },
  { id: 'planung', title: 'Planung & Aufgaben', description: 'Aufgaben anlegen, fortschreiben und Agenten nachziehen.', tools: ['task_create', 'task_update', 'agent_spawn'] },
  { id: 'projekt', title: 'Projektanalyse', description: 'Quellprojekt lesen, durchsuchen, strukturieren und Remote-Arbeit koordinieren.', tools: ['project_tree', 'project_search', 'project_read', 'remote_worker'] },
  { id: 'design', title: 'Designstudio', description: 'Projektstatus, zwei begründete visuelle Richtungen und Designauswahl je Villa.', tools: ['studio_status', 'studio_designs'] },
  { id: 'ausfuehrung', title: 'Ausfuehrung', description: 'Builds und Tests im Projekt starten (nur erlaubte Programme).', tools: ['project_run', 'project_write', 'project_patch'] },
  { id: 'artefakte', title: 'Artefakte', description: 'Dateien im Villa-Workspace schreiben und auflisten.', tools: ['artifact_write', 'artifact_patch', 'artifact_list'] },
  { id: 'recherche', title: 'Recherche', description: 'Websuche und Seitenabruf mit Jina-Reader-Kaskade.', tools: ['web_search', 'web_fetch'] },
  { id: 'medien', title: 'Medienproduktion', description: 'Fähigkeiten prüfen, Bild-/Video-/Audio-Produktionspakete vorbereiten und Medien über konfigurierte Fal.ai-Routen rendern.', tools: ['media_capabilities', 'media_prepare', 'media_generate'] },
  { id: 'extern', title: 'Connectoren & externe Dienste', description: 'Konfigurierte HTTPS-JSON-Connectoren, Fireflies-Meetingprotokolle und Asana-Aufgaben. Benötigte Secret-Referenzen: FIREFLIES_API_KEY, ASANA_PAT.', tools: ['connector_read', 'fireflies_transcripts', 'asana_list_projects', 'asana_create_task'] },
  { id: 'github', title: 'GitHub Produkt-Pack', description: 'Veröffentlicht ein fertiges Villa-Projekt in einem eigenen GitHub-Repository. Benötigt GITHUB_TOKEN im Secret-Speicher.', tools: ['github_publish'] },
  { id: 'compute-routing', title: 'Compute- & Gratis-Routen-Agent', description: 'Misst CPU, GPU und RAM, begrenzt Parallelität unter Ressourcenlast und entdeckt offizielle OpenRouter-Modelle nur bei ausgewiesenem Nullpreis.', tools: ['resource_status', 'free_route_status'] },
  { id: 'open-data', title: 'Offene Daten (keylos)', description: 'Wikipedia, Hacker News, Wetter, Waehrungen und Paket-Infos — alles ohne API-Key.', tools: ['wikipedia_search', 'hackernews_search', 'weather_lookup', 'currency_convert', 'package_info'] },
  { id: 'berichte', title: 'Berichte', description: 'Analyse-, Umsatz- und Review-Berichte ablegen.', tools: ['report_write'] }
];

/** Sicherheitsnetz: kein Pack darf ein Werkzeug doppelt beanspruchen. */
export function toolPackOf(toolName) {
  return TOOL_PACKS.find((p) => p.tools.includes(toolName)) || null;
}

/* --------------------------- Zustand --------------------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'feature',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`);

function rows() {
  return db.prepare('SELECT id, kind, enabled FROM packs').all();
}

export function packEnabled(id) {
  const row = db.prepare('SELECT enabled FROM packs WHERE id = ?').get(id);
  return row ? !!row.enabled : true; // unbekannt/nie angefasst = an
}

export function setPackEnabled(id, enabled) {
  const feature = FEATURE_PACKS.some((p) => p.id === id);
  const tool = TOOL_PACKS.some((p) => p.id === id);
  if (!feature && !tool) return { ok: false, error: `Unbekanntes Pack: ${id}` };
  db.prepare(
    'INSERT INTO packs (id, kind, enabled, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at'
  ).run(id, feature ? 'feature' : 'tool', enabled ? 1 : 0, now());
  return { ok: true, id, enabled: !!enabled };
}

/**
 * Darf dieses Werkzeug gerade benutzt werden?
 * Der Hauptschalter schlaegt alles; sonst entscheidet das eigene Werkzeug-Pack.
 */
export function canUseTool(toolName) {
  if (!toolEnabled(toolName)) return { allowed:false,reason:'Werkzeug wurde vom Master-Agent deaktiviert.' };
  if (!packEnabled(MASTER_PACK)) return { allowed: false, reason: 'Werkzeug-Pack (Hauptschalter) ist ausgeschaltet.' };
  const pack = toolPackOf(toolName);
  if (!pack) return { allowed: true }; // Werkzeuge ohne Pack bleiben erlaubt
  if (!packEnabled(pack.id)) return { allowed: false, reason: `Werkzeug-Pack „${pack.title}" ist ausgeschaltet.`, pack: pack.id };
  return { allowed: true, pack: pack.id };
}

/** Kompletter Pack-Zustand fuer API und Oberflaeche. */
export function packState() {
  const state = new Map(rows().map((r) => [r.id, !!r.enabled]));
  const features = FEATURE_PACKS.map((p) => ({
    ...p,
    enabled: state.has(p.id) ? state.get(p.id) : true,
    toolPacks: TOOL_PACKS.filter((t) => t.id === p.id).map((t) => t.id)
  }));
  const tools = TOOL_PACKS.map((p) => {
    const enabled = state.has(p.id) ? state.get(p.id) : true;
    const availability = p.tools.map((name) => ({ name, ...canUseTool(name) }));
    return { ...p, enabled, count: p.tools.length, effective: enabled && availability.some((tool) => tool.allowed), availability };
  });
  return {
    features,
    tools,
    master: { id: MASTER_PACK, enabled: packEnabled(MASTER_PACK) },
    blocked: tools.filter((p) => !p.effective).map((p) => p.id)
  };
}

/** Nur der Schalter-Zustand — fuer /api/stats und App. */
export function packSummary() {
  const s = packState();
  return {
    features: s.features.map((f) => ({ id: f.id, title: f.title, enabled: f.enabled })),
    toolPacks: s.tools.map((t) => ({ id: t.id, title: t.title, enabled: t.enabled, effective: t.effective, count: t.count })),
    master: s.master.enabled,
    blocked: s.blocked
  };
}
