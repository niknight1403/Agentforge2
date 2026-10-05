import { db, now, pruneHistory } from './db.mjs';
import { chat, derivePlan } from './llm.mjs';
import { emit } from './events.mjs';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { projectSummary, searchProject, readProjectFile, runCommand, safePath } from './fs-tools.mjs';

export const WORKSPACE = resolve(process.env.VF_WORKSPACE || join(process.cwd(), 'server', 'data', 'workspace'));
mkdirSync(WORKSPACE, { recursive: true });

const ROLES = ['PLANNER', 'RESEARCHER', 'ARCHITECT', 'CODER', 'REVIEWER', 'TESTER', 'DOCUMENTER', 'CRITIC', 'INTEGRATOR', 'WORKER', 'BUSINESS', 'GROWTH'];

/* ------------------------------------------------------------------ */
/* Werkzeuge                                                           */
/* ------------------------------------------------------------------ */

const TOOLS = {
  memory_write: {
    description: 'Schreibt einen dauerhaften Eintrag ins Gedaechtnis.',
    schema: { title: 'string', content: 'string', kind: 'FACT|DECISION|ARTIFACT|LESSON|IDEA|CONSTRAINT', importance: '1-10' },
    run: (ctx, a) => {
      db.prepare(
        'INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(ctx.villaId, ctx.agentId, 'villa', a.kind || 'FACT', String(a.title || 'Notiz'), String(a.content || ''), Number(a.importance) || 5, now());
      return `Gedaechtnis gespeichert: ${a.title}`;
    }
  },
  memory_search: {
    description: 'Durchsucht das Gedaechtnis der Villa.',
    schema: { query: 'string' },
    run: (ctx, a) => {
      const q = `%${String(a.query || '').toLowerCase()}%`;
      const rows = db.prepare(
        'SELECT title, content FROM memories WHERE villa_id = ? AND (lower(title) LIKE ? OR lower(content) LIKE ?) ORDER BY importance DESC LIMIT 10'
      ).all(ctx.villaId, q, q);
      return rows.length ? rows.map((r) => `- ${r.title}: ${r.content.slice(0, 200)}`).join('\n') : 'Keine Treffer.';
    }
  },
  web_fetch: {
    description: 'Laedt eine URL und gibt den Textinhalt zurueck (nur http/https).',
    schema: { url: 'string' },
    run: async (ctx, a) => {
      const url = String(a.url || '');
      if (!/^https?:\/\//i.test(url)) return 'Nur http/https erlaubt.';
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'VillaForge/1.0' } });
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return `HTTP ${res.status}\n${text.slice(0, 4000)}`;
    }
  },
  task_create: {
    description: 'Legt eine neue Teilaufgabe in der Villa an.',
    schema: { title: 'string', description: 'string', role: 'string', priority: '1-9' },
    run: (ctx, a) => {
      const id = db.prepare(
        'INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
      ).run(ctx.villaId, String(a.title || 'Aufgabe'), String(a.description || ''), 'PENDING', Number(a.priority) || 5, now(), now()).lastInsertRowid;
      return `Aufgabe #${id} angelegt: ${a.title}`;
    }
  },
  task_update: {
    description: 'Aktualisiert Status/Ergebnis einer Aufgabe.',
    schema: { id: 'number', status: 'PENDING|RUNNING|REVIEW|DONE|FAILED', result: 'string' },
    run: (ctx, a) => {
      db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ? AND villa_id = ?')
        .run(a.status || 'RUNNING', String(a.result || ''), now(), Number(a.id), ctx.villaId);
      return `Aufgabe #${a.id} -> ${a.status}`;
    }
  },
  agent_spawn: {
    description: 'Erzeugt weitere Agenten fuer die Villa.',
    schema: { role: 'string', count: '1-50', name: 'string' },
    run: (ctx, a) => {
      const count = Math.max(1, Math.min(Number(a.count) || 1, 50));
      let created = 0;
      for (let i = 0; i < count; i++) {
        if (agentCount(ctx.villaId) >= maxAgents(ctx.villaId)) break;
        const role = (a.role || 'WORKER').toUpperCase();
        insertAgent(ctx.villaId, `${a.name || role}-${Date.now() % 100000}-${i}`, ROLES.includes(role) ? role : 'WORKER', ctx.agentId);
        created++;
      }
      return `${created} Agent(en) erzeugt.`;
    }
  },
  artifact_write: {
    description: 'Schreibt eine Datei in den Villa-Workspace.',
    schema: { name: 'string', content: 'string' },
    run: (ctx, a) => {
      const safe = String(a.name || 'datei.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
      const dir = join(WORKSPACE, `villa-${ctx.villaId}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, safe), String(a.content || ''), 'utf8');
      return `Datei geschrieben: villa-${ctx.villaId}/${safe}`;
    }
  },
  artifact_list: {
    description: 'Listet Dateien im Villa-Workspace.',
    schema: {},
    run: (ctx) => {
      const dir = join(WORKSPACE, `villa-${ctx.villaId}`);
      try {
        return readdirSync(dir).map((f) => `${f} (${statSync(join(dir, f)).size} B)`).join('\n') || 'leer';
      } catch { return 'leer'; }
    }
  },
  project_tree: {
    description: 'Zeigt den Dateibaum des Quellprojekts (ohne node_modules, build und Verstecke).',
    schema: { limit: '1-400' },
    run: (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const s = projectSummary(root);
      if (!s.exists) return 'Quellordner nicht gefunden.';
      const lines = [
        `Dateien: ${s.files} · Groesse: ${(s.bytes / 1024).toFixed(0)} KiB`,
        'Sprachen: ' + s.languages.map((l) => `${l.ext} (${l.count})`).join(', '),
        'Wichtige Dateien: ' + (s.highlights.join(', ') || 'keine'),
        '',
        'Auszug:'
      ];
      for (const f of (s.tree || []).slice(0, Number(a.limit) || 120)) lines.push(`- ${f.path} (${f.size} B)`);
      return lines.join('\n');
    }
  },
  project_search: {
    description: 'Sucht Text in den Quelldateien des Projekts.',
    schema: { query: 'string', limit: '1-60' },
    run: (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const hits = searchProject(root, a.query, Number(a.limit) || 40);
      return hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'Keine Treffer.';
    }
  },
  project_read: {
    description: 'Liest eine Datei aus dem Quellprojekt.',
    schema: { path: 'string', maxBytes: 'number' },
    run: (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const r = readProjectFile(root, a.path, Number(a.maxBytes) || 40000);
      if (!r.ok) return r.error;
      return `${a.path}${r.truncated ? ' (gekuerzt)' : ''}:\n${r.content}`;
    }
  },
  project_run: {
    description: 'Fuehrt einen Build- oder Testbefehl im Projekt aus. Erlaubt sind npm, npx, node, python3, pip, gradle. Keine Shell, keine Netzwerk- oder Installationsschalter.',
    schema: { binary: 'string', args: 'string[]', timeoutMs: 'number' },
    run: async (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const r = await runCommand(root, a.binary, a.args, Number(a.timeoutMs) || 120000);
      if (r.error && !r.output) return `Nicht ausgefuehrt: ${r.error}`;
      return `Exit ${r.ok ? 0 : r.code}:\n${r.output || '(keine Ausgabe)'}`;
    }
  },
  report_write: {
    description: 'Speichert einen Bericht (ANALYSIS, REVENUE, PLAN, REVIEW) fuer die Villa.',
    schema: { kind: 'ANALYSIS|REVENUE|PLAN|REVIEW', title: 'string', content: 'string', data: 'object' },
    run: (ctx, a) => {
      const id = db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
        .run(ctx.villaId, String(a.kind || 'ANALYSIS').toUpperCase(), String(a.title || 'Bericht'), String(a.content || ''), JSON.stringify(a.data || {}), now()).lastInsertRowid;
      return `Bericht #${id} gespeichert: ${a.title}`;
    }
  }
};

export const TOOL_SPECS = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, schema: t.schema }));

/** Ermittelt den freigegebenen Quellordner einer Villa, falls vorhanden. */
export function sourceRoot(villaId) {
  const row = db.prepare('SELECT source_path FROM villas WHERE id = ?').get(villaId);
  if (!row || !row.source_path) return null;
  return resolve(row.source_path);
}

export function setSource(villaId, path) {
  const abs = path ? resolve(String(path)) : '';
  db.prepare('UPDATE villas SET source_path = ?, updated_at = ? WHERE id = ?').run(abs, now(), villaId);
  if (abs) {
    db.prepare('INSERT INTO sources (villa_id, path, kind, meta, created_at) VALUES (?,?,?,?,?)')
      .run(villaId, abs, 'PATH', '', now());
  }
  return abs;
}

function audit(villaId, agentId, tool, args, result, allowed = 1) {
  db.prepare('INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)')
    .run(now(), villaId, agentId, tool, JSON.stringify(args).slice(0, 500), String(result).slice(0, 500), allowed);
}

export async function runTool(ctx, name, args) {
  const tool = TOOLS[name];
  if (!tool) { audit(ctx.villaId, ctx.agentId, name, args, 'unbekanntes Werkzeug', 0); return `Unbekanntes Werkzeug: ${name}`; }
  emit('tool', { villaId: ctx.villaId, agentId: ctx.agentId, tool: name, args });
  try {
    const out = await tool.run(ctx, args || {});
    audit(ctx.villaId, ctx.agentId, name, args, out, 1);
    return out;
  } catch (err) {
    const msg = String(err.message || err);
    audit(ctx.villaId, ctx.agentId, name, args, msg, 0);
    return `Fehler in ${name}: ${msg}`;
  }
}

/* ------------------------------------------------------------------ */
/* Analyse bestehender Projekte                                        */
/* ------------------------------------------------------------------ */

/**
 * Untersucht ein bestehendes Projekt und entscheidet, ob ein sauberer Neubau
 * oder eine gezielte Optimierung sinnvoll ist. Ergebnis sind ein Analysebericht,
 * ein Umsatzbericht und ein daran ausgerichteter Aufgabenplan.
 */
export async function analyzeProject(villaId, rootId) {
  const root = sourceRoot(villaId);
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
  if (!root) return { plan: derivePlan(villa?.idea || '', 12), decision: 'UNKNOWN' };

  const summary = projectSummary(root);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(rootId);

  if (!summary.exists) {
    db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
      .run(villaId, 'ANALYSIS', 'Projekt nicht gefunden', `Der Ordner ${root} existiert nicht.`, '{}', now());
    return { plan: derivePlan(villa?.idea || '', 12), decision: 'NOT_FOUND' };
  }

  const facts = [
    `Projektordner: ${root}`,
    `Dateien: ${summary.files} · Groesse: ${(summary.bytes / 1024).toFixed(0)} KiB`,
    'Sprachen: ' + summary.languages.map((l) => `${l.ext} (${l.count})`).join(', '),
    'Wichtige Dateien: ' + (summary.highlights.join(', ') || 'keine')
  ].join('\n');

  // Ausgewaehlte Dateien einlesen, damit die Analyse auf echtem Code beruht.
  const samples = [];
  for (const rel of summary.highlights.slice(0, 8)) {
    const r = readProjectFile(root, rel, 6000);
    if (r.ok) samples.push(`### ${rel}\n${r.content.slice(0, 4000)}`);
  }
  for (const f of (summary.tree || []).filter((x) => /\.(kt|ts|js|py|java)$/.test(x.path)).slice(0, 6)) {
    const r = readProjectFile(root, f.path, 4000);
    if (r.ok) samples.push(`### ${f.path}\n${r.content.slice(0, 2500)}`);
  }

  const prompt = [
    `Idee des Nutzers: ${villa.idea}`,
    '',
    'Fakten zum bestehenden Projekt:',
    facts,
    '',
    'Auszuege aus dem Code:',
    samples.join('\n\n').slice(0, 20000),
    '',
    'Aufgabe: Beurteile, ob ein sauberer Neubau oder eine gezielte Optimierung sinnvoll ist.',
    'Antworte ausschliesslich mit JSON:',
    '{"decision":"REBUILD|OPTIMIZE","summary":"...","rationale":"...","keep":["..."],"replace":["..."],',
    ' "risks":["..."],"revenue":"...","tasks":[{"role":"CODER","title":"...","description":"...","priority":1}]}',
    'Regeln: decision REBUILD nur, wenn die Grundlage technisch nicht tragfaehig ist. Sonst OPTIMIZE.',
    'Erzeuge 10-16 Aufgaben. Nutze auch die Rollen BUSINESS und GROWTH fuer Umsatzfragen.'
  ].join('\n');

  const res = await runAgent(agent, prompt, { maxSteps: 6, villaId, mode: 'analysis' });

  let parsed = null;
  try { parsed = JSON.parse(String(res.answer || '').replace(/^```json\s*|\s*```$/g, '')); } catch { parsed = null; }

  const decision = ['REBUILD', 'OPTIMIZE'].includes(parsed?.decision) ? parsed.decision : 'OPTIMIZE';
  const analysisText = [
    `Entscheidung: ${decision}`,
    '',
    `Zusammenfassung: ${parsed?.summary || 'Keine Angabe (Offline-Planer).'}`,
    '',
    `Begruendung: ${parsed?.rationale || 'Ohne angebundenes Sprachmodell wurde regelbasiert entschieden.'}`,
    '',
    'Behalten: ' + ((parsed?.keep || []).join('; ') || '—'),
    'Ersetzen: ' + ((parsed?.replace || []).join('; ') || '—'),
    'Risiken: ' + ((parsed?.risks || []).join('; ') || '—'),
    '',
    'Fakten:',
    facts
  ].join('\n');

  db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
    .run(villaId, 'ANALYSIS', `Analyse: ${villa.name}`, analysisText, JSON.stringify(parsed || {}), now());
  db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, rootId, 'villa', 'DECISION', `Analyse: ${decision}`, analysisText.slice(0, 1500), 10, now());
  db.prepare('UPDATE villas SET mode = ?, updated_at = ? WHERE id = ?').run(decision, now(), villaId);
  emit('report', { villaId, kind: 'ANALYSIS', decision });

  const tasks = Array.isArray(parsed?.tasks) && parsed.tasks.length ? parsed.tasks : derivePlan(villa.idea, 12).tasks;
  return { decision, plan: { summary: parsed?.summary || `Analyse ${decision}`, tasks } };
}

/* ------------------------------------------------------------------ */
/* Agenten                                                             */
/* ------------------------------------------------------------------ */

const ROLE_BRIEF = {
  ROOT: 'Du bist der Deep Agent und leitest die Villa. Du planst, delegierst, pruefst Ergebnisse und fuehrst die Idee zum Abschluss. Du erkennst Luecken selbst und legst fehlende Aufgaben an.',
  PLANNER: 'Du zerlegst die Idee in klare, priorisierte Teilaufgaben mit messbarem Ergebnis und Akzeptanzkriterium. Liefere eine nummerierte Liste.',
  RESEARCHER: 'Du recherchierst Fakten, Technologien, Kosten und vergleichbare Loesungen. Trenne belegte Fakten von Annahmen und nenne Quellen.',
  ARCHITECT: 'Du entwirfst Architektur, Datenmodell, Schnittstellen und Deployment. Liefere Komponenten, Verantwortlichkeiten und den Ablauf in Textform.',
  CODER: 'Du implementierst konkreten, lauffaehigen Code. Gib vollstaendige Dateien mit Pfad an und erklaere die wichtigsten Entscheidungen.',
  REVIEWER: 'Du pruefst Qualitaet, Lesbarkeit, Sicherheit und Fehlerbehandlung. Nenne konkrete Fundstellen und Verbesserungen.',
  TESTER: 'Du entwirfst Tests inklusive Randfaellen und Fehlerszenarien. Liefere Testfaelle mit Eingabe und erwartetem Ergebnis.',
  DOCUMENTER: 'Du schreibst klare Dokumentation: Zweck, Nutzung, Beispiele und Betrieb.',
  CRITIC: 'Du suchst Luecken, Risiken, Widersprueche und unklare Annahmen. Sei direkt und begruende jeden Punkt.',
  INTEGRATOR: 'Du fuehrst Teilergebnisse zu einem stimmigen Gesamtergebnis zusammen und pruefst die Vollstaendigkeit.',
  WORKER: 'Du erledigst die zugewiesene Teilaufgabe praezise und lieferst ein verwertbares Ergebnis statt einer Absichtserklaerung.',
  BUSINESS: 'Du bewertest das Geschaeftsmodell: Zielgruppe, Zahlungsbereitschaft, Preise, Kosten, Marge und rechtliche Risiken. Nenne konkrete Zahlen und Annahmen.',
  GROWTH: 'Du planst Umsatzwachstum: Akquise-Kanaele, Aktivierung, Bindung, Empfehlungen und Messgroessen. Liefere einen 90-Tage-Plan mit Aufwand und erwarteter Wirkung.'
};

/** Welche Werkzeuge eine Rolle sinnvoll nutzt - schaerft die Agenten-Prompts. */
const ROLE_TOOLS = {
  PLANNER: 'task_create, memory_write, project_tree',
  RESEARCHER: 'web_fetch, memory_write, project_search',
  ARCHITECT: 'memory_write, artifact_write, project_read',
  CODER: 'artifact_write, artifact_list, project_read, project_search, project_run',
  REVIEWER: 'memory_search, memory_write, project_read, project_run',
  TESTER: 'artifact_write, memory_write, project_run',
  DOCUMENTER: 'artifact_write, project_read',
  CRITIC: 'memory_search, memory_write, project_read',
  INTEGRATOR: 'artifact_list, memory_write, project_run',
  WORKER: 'artifact_write, memory_write',
  BUSINESS: 'report_write, memory_write',
  GROWTH: 'report_write, memory_write, web_fetch',
  ROOT: 'memory_write, memory_search, task_create, agent_spawn, report_write'
};

/** Gemeinsamer Qualitaetsauftrag fuer alle Agenten. */
const QUALITY_RULES = [
  'Arbeite ergebnisorientiert: liefere konkrete Inhalte, keine Absichtserklaerungen.',
  'Pruefe deine Arbeit am Ende gegen die Aufgabenstellung und benenne offene Punkte.',
  'Speichere wichtige Ergebnisse und Entscheidungen ueber memory_write.',
  'Antworte auf Deutsch, gut lesbar, mit kurzen Absaetzen und Aufzaehlungen.'
].join('\n- ');

export function agentCount(villaId) {
  return db.prepare('SELECT COUNT(*) c FROM agents WHERE villa_id = ?').get(villaId).c;
}
function maxAgents(villaId) {
  return db.prepare('SELECT max_agents m FROM villas WHERE id = ?').get(villaId)?.m ?? 1000;
}

export function insertAgent(villaId, name, role, parentId = null, isRoot = 0) {
  const t = now();
  const tools = ROLE_TOOLS[role] || ROLE_TOOLS.WORKER;
  const sys = [
    ROLE_BRIEF[role] || ROLE_BRIEF.WORKER,
    `Rolle: ${role}.`,
    `Bevorzugte Werkzeuge: ${tools}.`,
    `Qualitaetsregeln:\n- ${QUALITY_RULES}`,
    'Schliesse jede Aufgabe mit einem pruefbaren Ergebnis ab.'
  ].join('\n');
  return db.prepare(
    'INSERT INTO agents (villa_id, name, role, system_prompt, status, is_root, parent_id, permissions, autonomy_level, created_at, last_active_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(villaId, name, role, sys, 'IDLE', isRoot, parentId, 127, 3, t, t).lastInsertRowid;
}

export function memoryContext(villaId, agentId, limit = 12) {
  const rows = db.prepare(
    'SELECT kind, title, content FROM memories WHERE villa_id = ? ORDER BY importance DESC, id DESC LIMIT ?'
  ).all(villaId, limit);
  if (!rows.length) return '';
  return '\n\nBekanntes Gedaechtnis:\n' + rows.map((r) => `- [${r.kind}] ${r.title}: ${r.content.slice(0, 300)}`).join('\n');
}

function openTasks(villaId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY') ORDER BY priority ASC, id ASC"
  ).all(villaId);
}

/** Fuehrt einen Agenten in einem begrenzten ReAct-Loop aus. */
export async function runAgent(agent, userPrompt, { maxSteps = 8, villaId = agent.villa_id, mode = 'agent' } = {}) {
  const ctx = { villaId, agentId: agent.id };
  const context = statusContext(villaId);
  const history = [
    { role: 'system', content: `${agent.system_prompt}${memoryContext(villaId, agent.id)}\n\nWerkzeuge: ${JSON.stringify(TOOL_SPECS)}\n\nAntworte IMMER mit genau einem JSON-Objekt: entweder {"tool":"name","args":{...}} um ein Werkzeug zu nutzen, oder {"final":"..."} um abzuschliessen.\n\nVerfasse "final" als gut lesbaren Text mit kurzen Absaetzen und Aufzaehlungen. Kein Markdown-Sternchen, keine rohen JSON-Daten.` },
    { role: 'user', content: userPrompt }
  ];

  const trace = [];
  for (let step = 0; step < maxSteps; step++) {
    let out;
    try {
      out = await chat(history, { json: true, mode, context, temperature: 0.4, maxTokens: 1500 });
    } catch (err) {
      return { error: String(err.message || err), trace };
    }
    let parsed = null;
    try { parsed = JSON.parse(out.content); } catch { /* Freitext */ }

    if (parsed && parsed.tool && TOOLS[parsed.tool]) {
      const result = await runTool(ctx, parsed.tool, parsed.args);
      trace.push({ step, tool: parsed.tool, args: parsed.args, result });
      history.push({ role: 'assistant', content: out.content });
      history.push({ role: 'user', content: `Werkzeug-Ergebnis (${parsed.tool}): ${String(result).slice(0, 2000)}` });
      continue;
    }

    // Freitext statt JSON: weiterarbeiten statt den Lauf abzubrechen.
    const looksJson = out.content.trim().startsWith('{');
    if (!parsed && !looksJson && step < maxSteps - 1 && out.offline === undefined) {
      trace.push({ step, note: 'Antwort war kein JSON, Anfrage wiederholt.' });
      history.push({ role: 'assistant', content: out.content.slice(0, 400) });
      history.push({ role: 'user', content: 'Deine Antwort war kein gueltiges JSON. Antworte erneut mit genau einem Objekt: {"tool":"...","args":{...}} oder {"final":"..."}.' });
      continue;
    }

    const final = parsed?.final ?? out.content;
    trace.push({ step, final: true });
    return { answer: prettify(String(final)), route: out.route, model: out.model, trace, offline: !!out.offline };
  }
  return { answer: 'Ich habe die maximale Schrittzahl erreicht. Bitte formuliere die Aufgabe kleiner oder starte die autonome Ausführung.', trace };
}

/** Kurzer, lesbarer Statusbericht der Villa fuer den Chat-Kontext. */
export function statusContext(villaId) {
  const villa = db.prepare('SELECT name, status FROM villas WHERE id = ?').get(villaId);
  if (!villa) return '';
  const agents = agentCount(villaId);
  const open = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING','REVIEW')").get(villaId).c;
  const done = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'DONE'").get(villaId).c;
  const total = db.prepare('SELECT COUNT(*) c FROM tasks WHERE villa_id = ?').get(villaId).c;
  const next = db.prepare("SELECT title FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY') ORDER BY priority ASC, id ASC LIMIT 3").all(villaId);
  const lines = [
    `Villa: ${villa.name} (Status ${villa.status})`,
    `Agenten: ${agents} · Aufgaben erledigt: ${done}/${total} · offen: ${open}`
  ];
  if (next.length) lines.push('Naechste offene Aufgaben: ' + next.map((t) => t.title).join('; '));
  return lines.join('\n');
}

/** Wandelt JSON-Reste und Sternchen-Markdown in lesbaren Text um. */
export function prettify(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    try {
      const o = JSON.parse(s);
      s = String(o.final ?? o.answer ?? o.content ?? s);
    } catch { /* unveraendert lassen */ }
  }
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[*+-]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Erstellt eine Villa samt Root-Agent, Plan und Agentenpool. */
export async function createVilla({ name, idea, agentCount: wanted = 12, sourcePath = '', mode = 'BUILD' }) {
  const t = now();
  const villaId = db.prepare(
    'INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(name || 'Villa', idea || '', 'PLANNING', 1000, 1, t, t).lastInsertRowid;

  const rootId = insertAgent(villaId, 'DeepAgent', 'ROOT', null, 1);
  emit('villa', { villaId, status: 'PLANNING' });

  if (sourcePath) {
    setSource(villaId, sourcePath);
    db.prepare('UPDATE villas SET mode = ? WHERE id = ?').run(mode || 'ANALYZE', villaId);
  }

  const planRaw = await chat(
    [
      { role: 'system', content: 'Du bist ein erfahrener Projektplaner. Antworte ausschliesslich mit JSON: {"summary":"...","tasks":[{"role":"PLANNER","title":"...","description":"..."}]}.' },
      { role: 'user', content: `Idee: ${idea}\nErzeuge 8-14 praezise Teilaufgaben mit passender Rolle aus ${ROLES.join(', ')}.` }
    ],
    { json: true, mode: 'plan', temperature: 0.5, agentCount: wanted }
  );

  let plan;
  try { plan = JSON.parse(planRaw.content); } catch { plan = derivePlan(idea, wanted); }
  if (!plan.tasks || !plan.tasks.length) plan = derivePlan(idea, wanted);

  db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, rootId, 'villa', 'DECISION', 'Projektplan', plan.summary || `Plan fuer ${idea}`, 9, now());

  // Analyse-Modus: erst das bestehende Projekt verstehen, dann entscheiden.
  if (sourcePath) {
    const analysis = await analyzeProject(villaId, rootId);
    plan = analysis.plan;
  }

  for (const task of plan.tasks) {
    db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(villaId, String(task.title || 'Aufgabe'), String(task.description || ''), 'PENDING', Number(task.priority) || 5, now(), now());
  }

  // Agentenpool: mindestens 1 Agent je Rolle, Rest als WORKER, hart begrenzt auf max_agents.
  const total = Math.max(3, Math.min(Number(wanted) || 12, 1000));
  const roles = [];
  for (let i = 0; i < total; i++) roles.push(ROLES[i % ROLES.length]);
  for (let i = 0; i < roles.length; i++) {
    if (agentCount(villaId) >= maxAgents(villaId)) break;
    insertAgent(villaId, `${roles[i]}-${String(i + 1).padStart(3, '0')}`, roles[i], rootId);
  }

  db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run('RUNNING', now(), villaId);
  emit('villa', { villaId, status: 'RUNNING', agents: agentCount(villaId) });
  return { villaId, rootId, plan, agents: agentCount(villaId) };
}

/**
 * Import einer Villa aus einem Export-JSON (GET /api/villas/:id/export).
 * Alle Datensaetze bekommen neue IDs: Agenten zuerst (wegen parent_id),
 * dann Aufgaben, Gedaechnis, Berichte und die letzten Nachrichten.
 * Fuer jeden Datensatz gelten harte Obergrenzen, damit ein manipuliertes
 * oder riesiges Exportfile den Hub nicht ueberlaeuft.
 */
const IMPORT_LIMITS = { agents: 500, tasks: 2000, memories: 500, reports: 100, messages: 1000 };

export function importVilla(payload, { nameOverride = '' } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.villa || typeof payload.villa !== 'object') {
    return { ok: false, error: 'Export-Format ungueltig: villa-Objekt fehlt (erwartet wird ein Export aus GET /api/villas/:id/export)' };
  }
  const idea = String(payload.villa.idea || '').trim();
  if (!idea) return { ok: false, error: 'idea fehlt im Export' };
  if (idea.length > 2000) return { ok: false, error: 'idea zu lang (max. 2000 Zeichen)' };
  const name = String(nameOverride || payload.villa.name || 'Importierte Villa').trim().slice(0, 120) || 'Importierte Villa';
  const maxAgents = Math.min(Math.max(Number(payload.villa.max_agents) || 1000, 3), 1000);

  const lists = {};
  for (const key of Object.keys(IMPORT_LIMITS)) {
    const arr = Array.isArray(payload[key]) ? payload[key] : [];
    lists[key] = arr.slice(0, IMPORT_LIMITS[key]);
  }

  const t = now();
  const villaId = db.prepare(
    "INSERT INTO villas (name, idea, status, max_agents, autonomy, source_path, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(name, idea, 'CREATED', maxAgents, 1, String(payload.villa.source_path || '').slice(0, 1024), 'BUILD', t, t).lastInsertRowid;

  // Agenten zuerst: neue IDs merken, parent_id und agent_id spaeter umsetzen.
  const agentMap = new Map();
  let rootSeen = false;
  for (const a of lists.agents) {
    if (!a || typeof a !== 'object' || !a.name) continue;
    const isRoot = a.is_root ? 1 : 0;
    if (isRoot && rootSeen) continue; // hoechstens ein Wurzel-Agent
    if (isRoot) rootSeen = true;
    const newId = insertAgent(
      villaId,
      String(a.name).slice(0, 120),
      String(a.role || 'WORKER').slice(0, 40),
      null,
      isRoot
    );
    agentMap.set(Number(a.id), newId);
    if (a.system_prompt) db.prepare('UPDATE agents SET system_prompt = ? WHERE id = ?').run(String(a.system_prompt).slice(0, 4000), newId);
    if (a.autonomy_level != null) db.prepare('UPDATE agents SET autonomy_level = ? WHERE id = ?').run(Math.min(Math.max(Number(a.autonomy_level) || 3, 0), 5), newId);
  }
  if (!rootSeen) {
    // Ohne Wurzel-Agent ist keine Villa bedienbar (Chat leitet an is_root).
    const rootId = insertAgent(villaId, 'DeepAgent', 'ROOT', null, 1);
    agentMap.set(0, rootId);
  }

  for (const task of lists.tasks) {
    if (!task || typeof task !== 'object' || !task.title) continue;
    const status = ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'BLOCKED'].includes(task.status) ? task.status : 'PENDING';
    db.prepare('INSERT INTO tasks (villa_id, agent_id, title, description, status, priority, result, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        villaId,
        agentMap.get(Number(task.agent_id)) ?? null,
        String(task.title).slice(0, 300),
        String(task.description || '').slice(0, 4000),
        status,
        Math.min(Math.max(Number(task.priority) || 5, 1), 9),
        String(task.result || '').slice(0, 20000),
        Number(task.created_at) || t,
        Number(task.updated_at) || t
      );
  }

  for (const m of lists.memories) {
    if (!m || typeof m !== 'object' || !m.title) continue;
    db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(
        villaId,
        agentMap.get(Number(m.agent_id)) ?? null,
        ['villa', 'agent'].includes(m.scope) ? m.scope : 'villa',
        String(m.kind || 'FACT').slice(0, 40),
        String(m.title).slice(0, 300),
        String(m.content || '').slice(0, 20000),
        Math.min(Math.max(Number(m.importance) || 5, 1), 10),
        Number(m.created_at) || t
      );
  }

  for (const r of lists.reports) {
    if (!r || typeof r !== 'object' || !r.title) continue;
    db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
      .run(
        villaId,
        String(r.kind || 'ANALYSIS').slice(0, 40),
        String(r.title).slice(0, 300),
        String(r.content || '').slice(0, 50000),
        String(r.data || '').slice(0, 100000),
        Number(r.created_at) || t
      );
  }

  for (const msg of lists.messages) {
    if (!msg || typeof msg !== 'object' || !msg.content) continue;
    const agentId = agentMap.get(Number(msg.agent_id)) ?? agentMap.get(0);
    if (agentId == null) continue;
    db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, tool, created_at) VALUES (?,?,?,?,?,?)')
      .run(
        villaId,
        agentId,
        msg.role === 'user' ? 'user' : 'assistant',
        String(msg.content).slice(0, 20000),
        msg.tool ? String(msg.tool).slice(0, 80) : null,
        Number(msg.created_at) || t
      );
  }

  emit('villa_imported', { villaId, agents: agentMap.size, tasks: lists.tasks.length });
  return {
    ok: true,
    villaId,
    counts: {
      agents: agentMap.size,
      tasks: lists.tasks.length,
      memories: lists.memories.length,
      reports: lists.reports.length,
      messages: lists.messages.length
    }
  };
}

/**
 * Verifikation: laeuft ein echtes Projekt vorliegt, werden die hinterlegten
 * Build- und Testbefehle ausgefuehrt. Das Ergebnis landet als Bericht und, bei
 * Fehlern, als neue Aufgabe in der Villa.
 */
async function verifyProject(villaId) {
  const root = sourceRoot(villaId);
  if (!root) return { ok: true, skipped: true, note: 'Kein Quellprojekt hinterlegt.' };

  const steps = [];
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}; } catch { scripts = {}; }
    if (scripts.build) steps.push(['npm', ['run', 'build']]);
    if (scripts.test) steps.push(['npm', ['test']]);
  }
  const gradlew = join(root, 'gradlew');
  if (existsSync(gradlew) && !steps.length) steps.push(['gradle', ['--offline', 'test']]);

  if (!steps.length) {
    db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
      .run(villaId, 'REVIEW', 'Verifikation uebersprungen', 'Im Projekt wurde kein bekannter Build- oder Testbefehl gefunden (package.json mit build/test oder gradlew).', '{}', now());
    return { ok: true, skipped: true };
  }

  const lines = [];
  let ok = true;
  for (const [bin, args] of steps) {
    const r = await runCommand(root, bin, args, 180_000);
    lines.push(`$ ${bin} ${args.join(' ')}`);
    lines.push(`Exit ${r.ok ? 0 : r.code}`);
    lines.push((r.output || r.error || '(keine Ausgabe)').slice(-2500));
    lines.push('');
    if (!r.ok) { ok = false; break; }
  }

  const text = lines.join('\n');
  db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
    .run(villaId, 'REVIEW', ok ? 'Verifikation bestanden' : 'Verifikation fehlgeschlagen', text, JSON.stringify({ steps: steps.map((s) => s.join(' ')) }), now());
  db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, null, 'villa', ok ? 'LESSON' : 'CONSTRAINT', ok ? 'Build und Tests laufen' : 'Build oder Tests schlagen fehl', text.slice(0, 1500), ok ? 7 : 10, now());
  emit('report', { villaId, kind: 'REVIEW', ok });

  if (!ok) {
    db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(villaId, 'Build- und Testfehler beheben', `Die Verifikation ist fehlgeschlagen. Fehlerausgabe:\n${text.slice(0, 3000)}`, 'PENDING', 1, now(), now());
  }
  return { ok };
}

/* ------------------------------------------------------------------ */
/* Orchestrierung                                                      */
/* ------------------------------------------------------------------ */

const running = new Map(); // villaId -> { stop, processed, concurrency }

export function isRunning(villaId) { return !!running.get(villaId); }
export function listRunning() { return [...running.keys()]; }

export function stopVilla(villaId) {
  const job = running.get(villaId);
  if (!job) return false;
  job.stop = true;
  emit('villa', { villaId, status: 'STOPPING' });
  return true;
}

export async function orchestrate(villaId, { concurrency = 4, maxTasks = 500, adaptive = true, maxRounds = 6 } = {}) {
  if (running.get(villaId)) return;
  const job = { stop: false, processed: 0, concurrency: Math.max(1, Math.min(Number(concurrency) || 4, 12)) };
  running.set(villaId, job);
  // Verwaiste Aufgaben aus einem abgebrochenen Lauf zurueck auf PENDING setzen.
  // Beim Start eines Laufs kann keine Aufgabe legitim auf RUNNING stehen: dieser
  // Prozess hat noch keine gestartet. Solche Eintraege stammen aus einem Absturz
  // und wuerden sonst nie wieder aufgegriffen.
  const orphans = db.prepare("UPDATE tasks SET status = 'PENDING', updated_at = ? WHERE villa_id = ? AND status = 'RUNNING'").run(now(), villaId);
  if (orphans.changes > 0) {
    console.log(`[villaforge] ${orphans.changes} verwaiste Aufgabe(n) in Villa ${villaId} wieder aufgenommen.`);
  }
  // Rundenstand auf 0 setzen: die Obergrenze gilt je Lauf, nicht ueber Laeufe hinweg.
  db.prepare('UPDATE villas SET status = ?, auto_rounds = 0, updated_at = ? WHERE id = ?').run('RUNNING', now(), villaId);
  emit('villa', { villaId, status: 'RUNNING', concurrency: job.concurrency });

  try {
    while (job.processed < maxTasks) {
      if (job.stop) break;

      const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
      if (!villa || villa.autonomy === 0) break;

      const tasks = openTasks(villaId);

      // Alles erledigt: der Deep Agent prueft und ergaenzt fehlende Aufgaben.
      // Die Runden sind gedeckelt und liegen in der Villa, damit ein Neustart
      // nicht wieder bei null beginnt und der Lauf garantiert endet.
      if (!tasks.length) {
        const rounds = Number(villa.auto_rounds || 0);
        if (adaptive && rounds < maxRounds) {
          db.prepare('UPDATE villas SET auto_rounds = auto_rounds + 1, updated_at = ? WHERE id = ?').run(now(), villaId);
          const added = await reviewAndExpand(villaId);
          emit('progress', { villaId, processed: job.processed, open: 0, added, round: rounds + 1, maxRounds });
          if (added > 0) continue;
        }
        break;
      }

      // Rollenpassende Aufgaben zuerst, damit Agenten nicht fachfremd arbeiten.
      tasks.sort((a, b) => (guessRole(a) === guessRole(b) ? a.priority - b.priority : 0));

      const batch = tasks.slice(0, job.concurrency);
      for (const task of batch) {
        db.prepare("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(now(), task.id);
      }

      await Promise.all(batch.map((task) => executeTask(villaId, task)));
      job.processed += batch.length;
      emit('progress', { villaId, processed: job.processed, open: openTasks(villaId).length });
    }

    // History-Rotation: vollendete Laeufe kuerzen audit/memories auf Fenster.
    const pruned = pruneHistory(villaId);

    const open = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING','REVIEW')").get(villaId).c;
    let status = job.stop ? 'PAUSED' : (open === 0 ? 'COMPLETED' : 'PAUSED');

    // Bei fertigem Lauf das echte Projekt bauen und testen.
    if (status === 'COMPLETED' && adaptive) {
      const v = await verifyProject(villaId);
      if (v && v.ok === false) {
        emit('progress', { villaId, verification: 'failed' });
        status = 'PAUSED';
      } else {
        emit('progress', { villaId, verification: v?.skipped ? 'skipped' : 'passed' });
      }
    }

    db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), villaId);
    emit('villa', { villaId, status, processed: job.processed });
  } catch (err) {
    db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run('FAILED', now(), villaId);
    emit('villa', { villaId, status: 'FAILED', error: String(err.message || err) });
  } finally {
    running.delete(villaId);
  }
}

/**
 * Der Deep Agent prueft den Gesamtstand und ergaenzt fehlende Aufgaben.
 * Das macht die Villa selbstheilend, ohne in eine Endlosschleife zu laufen.
 */
async function reviewAndExpand(villaId) {
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
  const root = db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(villaId);
  if (!villa || !root) return 0;

  const done = db.prepare("SELECT title, result FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY id ASC LIMIT 40").all(villaId);
  const summary = done.map((t) => `- ${t.title}: ${String(t.result || '').slice(0, 160)}`).join('\n');

  const res = await runAgent(
    root,
    `Idee: ${villa.idea}\n\nBisher erledigte Aufgaben:\n${summary || '(keine)'}\n\n` +
      'Pruefe, ob die Idee damit vollstaendig und umsetzbar ist. Lege fehlende Aufgaben mit task_create an (hoechstens 5). ' +
      'Wenn nichts fehlt, antworte mit {"final":"Fertig"} ohne Werkzeugaufruf.',
    { maxSteps: 6, villaId }
  );

  const created = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'PENDING'").get(villaId).c;
  if (created > 0 && res.answer) {
    db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(villaId, root.id, 'villa', 'DECISION', 'Abschlusspruefung', String(res.answer).slice(0, 1500), 8, now());
  }
  return created;
}

async function executeTask(villaId, task) {
  const role = guessRole(task);
  // Bevorzugt einen freien Agenten der passenden Rolle, damit parallele
  // Aufgaben nicht denselben Agenten doppelt belegen.
  const agent =
    db.prepare("SELECT * FROM agents WHERE villa_id = ? AND role = ? AND is_root = 0 AND status = 'IDLE' LIMIT 1").get(villaId, role) ||
    db.prepare("SELECT * FROM agents WHERE villa_id = ? AND role = ? AND is_root = 0 LIMIT 1").get(villaId, role) ||
    db.prepare("SELECT * FROM agents WHERE villa_id = ? AND is_root = 0 AND status = 'IDLE' LIMIT 1").get(villaId) ||
    db.prepare("SELECT * FROM agents WHERE villa_id = ? AND is_root = 0 LIMIT 1").get(villaId) ||
    db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(villaId);
  if (!agent) return;

  db.prepare('UPDATE agents SET status = ?, last_active_at = ? WHERE id = ?').run('THINKING', now(), agent.id);
  db.prepare('UPDATE tasks SET agent_id = ?, updated_at = ? WHERE id = ?').run(agent.id, now(), task.id);
  emit('task', { villaId, taskId: task.id, agentId: agent.id, status: 'RUNNING', title: task.title });

  const idea = db.prepare('SELECT idea FROM villas WHERE id = ?').get(villaId)?.idea;
  const prompt = [
    `Villa-Idee: ${idea}`,
    '',
    `Deine Teilaufgabe: ${task.title}`,
    `Beschreibung: ${task.description}`,
    '',
    'Vorgehen:',
    '1. Pruefe zuerst mit memory_search, ob es bereits verwertbare Ergebnisse gibt.',
    '2. Erledige die Aufgabe inhaltlich vollstaendig.',
    '3. Speichere das Ergebnis mit memory_write und, wenn sinnvoll, als Datei mit artifact_write.',
    '4. Schliesse mit {"final":"..."} ab. Das Ergebnis muss ohne Nachfragen verwendbar sein.'
  ].join('\n');

  const res = await runAgent(agent, prompt, { maxSteps: 7, villaId });

  // Offline-Rettefall: kein echtes Modell war erreichbar. So eine Antwort
  // ist keine erledigte Aufgabe — sie wuerde nur Plannertext als Ergebnis
  // vortaeschen. Stattdessen ehrlich FAILED und spaeter neu starten.
  const offline = !!res.offline && !res.error;
  const answer = offline
    ? `${res.answer}\n\n(Hinweis: Aufgabe NICHT erledigt — kein Sprachmodell erreichbar, Offline-Planer hat geantwortet. Route erneut starten, wenn die Anbindung wieder frei ist.)`
    : (res.answer || res.error || 'Kein Ergebnis.');
  const status = res.error || offline ? 'FAILED' : 'DONE';
  db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?').run(status, answer.slice(0, 4000), now(), task.id);
  db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)').run(villaId, agent.id, 'assistant', answer.slice(0, 4000), now());
  if (!offline) {
    db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(villaId, agent.id, 'villa', 'ARTIFACT', `Ergebnis: ${task.title}`, answer.slice(0, 2000), 6, now());
  }
  db.prepare('UPDATE agents SET status = ?, last_active_at = ? WHERE id = ?').run('IDLE', now(), agent.id);

  emit('task', { villaId, taskId: task.id, agentId: agent.id, status, offline, title: task.title, answer: answer.slice(0, 500) });
}

export function guessRole(task) {
  const t = `${task.title} ${task.description}`.toLowerCase();
  if (/plan|anforder|ziel/.test(t)) return 'PLANNER';
  if (/umsatz|monetar|preis|zahl|geschaeft|business|erlös|erloes|marge/.test(t)) return 'BUSINESS';
  if (/wachstum|marketing|akquise|kunden|growth|funnel|vertrieb/.test(t)) return 'GROWTH';
  if (/recher|markt|studie/.test(t)) return 'RESEARCHER';
  if (/architekt|design|modell/.test(t)) return 'ARCHITECT';
  if (/code|implement|entwickl/.test(t)) return 'CODER';
  if (/review|qualitaet/.test(t)) return 'REVIEWER';
  if (/test|fehler/.test(t)) return 'TESTER';
  if (/dokument|readme/.test(t)) return 'DOCUMENTER';
  if (/risiko|kritik/.test(t)) return 'CRITIC';
  if (/integrat|release|zusammen/.test(t)) return 'INTEGRATOR';
  return 'WORKER';
}
