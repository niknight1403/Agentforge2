import { studioStatus,proposeDesigns } from './studio.mjs';
import { executeRemoteWorker } from './remote-worker.mjs';
import { PROJECT_WORKSPACE,ownProjectDir,verifyProjectRuntime,ensureVerificationTasks } from './project-verification.mjs';
import { db, now } from './db.mjs';
import { maybeDeliverApk } from './builds.mjs';
import { skillInstructions, readConnector } from './control-store.mjs';
import { resourceStatus, recommendedConcurrency } from './resource-agent.mjs';
import { freeRouteCycleStatus } from './free-route-cycle.mjs';
import { pruneHistory } from './maintenance.mjs';
import { chat, enabledRoutes, resolveKey, derivePlan } from './llm.mjs';
import { emit } from './events.mjs';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { execSync,execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { projectSummary, searchProject, readProjectFile, runCommand, safePath } from './fs-tools.mjs';
import { canUseTool, toolPackOf, packEnabled } from './packs.mjs';
import { generateMedia, mediaCapabilities } from './media.mjs';
import { saveCheckpoint, recoverCheckpoint } from './checkpoints.mjs';
import { withOtelSpan } from './otel.mjs';
import { ROLES } from './agent-roles.mjs';
import { normalizeSwarmBlueprint } from './swarm.mjs';
export { normalizeSwarmBlueprint } from './swarm.mjs';


export const WORKSPACE = PROJECT_WORKSPACE;
mkdirSync(WORKSPACE, { recursive: true });

/** v1.40.0 — Projektordner der Villa: hier entsteht der ECHTE Produktcode. */
export function villaProjectDir(villaId) {
  return ownProjectDir(villaId);
}

export { ROLES } from './agent-roles.mjs';

/* ------------------------------------------------------------------ */
/* Werkzeuge                                                           */
/* ------------------------------------------------------------------ */

const TOOLS = {
  resource_status: { description:'Liefert gemessene CPU-, GPU- und RAM-Auslastung samt einer sicheren Parallelitaetsempfehlung.', schema:{}, run:() => JSON.stringify(resourceStatus()) },
  free_route_status: { description:'Zeigt ausschließlich lokale oder explizit kostenlose KI-Routen und den letzten offiziellen Discovery-Scan.', schema:{}, run:() => JSON.stringify(freeRouteCycleStatus()) },
  remote_worker:{description:'Einen begrenzten Rechenauftrag an den vom Administrator konfigurierten Remote-Worker senden. Erst nach Konfiguration nutzbar; keine GPU-Buchung.',schema:{task:'string',input:'object|array'},run:async(ctx,a)=>JSON.stringify(await executeRemoteWorker(a.task,a.input))},
  studio_status:{description:'Echte Abnahmeblocker, nächste Schritte und Live-Vorschau dieses Projekts.',schema:{},run:ctx=>JSON.stringify(studioStatus(ctx.villaId))},
  studio_designs:{description:'Zwei ideenspezifische UI-Designrichtungen mit Farben, Layout, Nutzerfluss und Abnahmekriterien vorschlagen. Noch keine Umsetzung.',schema:{},run:async ctx=>JSON.stringify(await proposeDesigns(ctx.villaId))},
  connector_read: { description:'Liest JSON über einen konfigurierten HTTPS-Connector (GET).', schema:{connectorId:'string'}, run:async (ctx,a)=>JSON.stringify(await readConnector(String(a.connectorId))).slice(0,12000) },
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
      return rows.length ? rows.map((r) => `- ${r.title}: ${String(r.content || '').slice(0, 200)}`).join('\n') : 'Keine Treffer.';
    }
  },
  web_fetch: {
    description: 'Laedt eine URL und gibt den Text zurueck - Kaskade: Jina Reader (Markdown, kostenlos) -> Direkt-Fetch (nur http/https).',
    schema: { url: 'string' },
    run: async (ctx, a) => {
      const url = String(a.url || '');
      if (!/^https?:\/\//i.test(url)) return 'Nur http/https erlaubt.';
      /* Stufe 1: Jina Reader - sauberes Markdown ohne Key */
      try {
        const r = await fetch(`https://r.jina.ai/${url}`, {
          signal: AbortSignal.timeout(25000),
          headers: { 'User-Agent': 'VillaForge/1.0', 'Accept': 'text/plain' }
        });
        if (r.ok) {
          const md = await r.text();
          if (md && md.trim().length > 80) return `QUELLE: Jina Reader (Markdown)\n${md.slice(0, 4000)}`;
        }
      } catch { /* naechste Stufe */ }
      /* Stufe 2: Direkt-Fetch mit Tag-Strip */
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'VillaForge/1.0' } });
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return `HTTP ${res.status}\n${text.slice(0, 4000)}`;
    }
  },
  web_search: {
    description: 'Kostenlose Websuche ohne API-Key (Kaskade DuckDuckGo HTML -> DDG Lite). Liefert Titel, URLs und Snippets.',
    schema: { query: 'string' },
    run: async (ctx, a) => {
      const q = String(a.query || '').trim();
      if (!q) return 'Leere Suchanfrage.';
      const decodeHref = (h) => {
        try {
          if (h.includes('uddg=')) return decodeURIComponent(h.split('uddg=')[1].split('&')[0]);
          if (h.startsWith('//')) return 'https:' + h;
          return h;
        } catch { return h; }
      };
      /* Stufe 1: DuckDuckGo HTML (keyless) */
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }
        });
        const html = await res.text();
        const links = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
        const snips = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
        const out = [];
        for (let i = 0; i < links.length && out.length < 6; i++) {
          const url = decodeHref(links[i][1]);
          if (!/^https?:\/\//.test(url)) continue;
          const title = links[i][2].replace(/<[^>]+>/g, '').trim();
          const snip = (snips[i] ? snips[i][1].replace(/<[^>]+>/g, '').trim() : '').slice(0, 220);
          out.push(`- ${title}\n  ${url}\n  ${snip}`);
        }
        if (out.length) return `WEB-SUCHE: "${q}" (${out.length} Treffer, DuckDuckGo)\n${out.join('\n')}`;
      } catch { /* naechste Stufe */ }
      /* Stufe 2: DDG Lite (POST, keyless) */
      try {
        const res = await fetch('https://lite.duckduckgo.com/lite/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
          body: 'q=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(15000)
        });
        const html = await res.text();
        const links = [...html.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
        const out = [];
        for (let i = 0; i < links.length && out.length < 6; i++) {
          const url = decodeHref(links[i][1]);
          if (url.includes('duckduckgo.com')) continue;
          const title = links[i][2].replace(/<[^>]+>/g, '').trim();
          out.push(`- ${title}\n  ${url}`);
        }
        if (out.length) return `WEB-SUCHE: "${q}" (${out.length} Treffer, DDG Lite)\n${out.join('\n')}`;
      } catch { /* naechste Stufe */ }
      return 'WEB-SUCHE: Alle Suchstufen blockiert (Rate-Limit?). Spaeter erneut versuchen oder web_fetch mit bekannter URL nutzen.';
    }
  },
  artifact_patch: {
    description: 'Ersetzt in einer Workspace-Datei einen Textabschnitt (schneller und guenstiger als artifact_write fuer kleine Aenderungen).',
    schema: { name: 'string', find: 'string', replace: 'string', all: 'boolean' },
    run: (ctx, a) => {
      const safe = String(a.name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const dir = join(WORKSPACE, `villa-${ctx.villaId}`);
      const full = join(dir, safe);
      if (!existsSync(full)) return `Datei nicht gefunden: ${safe}. Lege sie zuerst mit artifact_write an.`;
      let text;
      try { text = readFileSync(full, 'utf8'); } catch (err) { return `Lesefehler: ${err.message}`; }
      const needle = String(a.find || '');
      if (!needle || !text.includes(needle)) return 'Zu ersetzender Text nicht gefunden. Pruefe den Wortlaut (artifact_list/project_read).';
      if (a.all) {
        const outAll = text.split(needle).join(String(a.replace ?? ''));
        writeFileSync(full, outAll, 'utf8');
        return `${safe}: alle Vorkommen ersetzt.`;
      }
      const out = text.replace(needle, String(a.replace ?? ''));
      writeFileSync(full, out, 'utf8');
      return `${safe}: 1 Vorkommen ersetzt.`;
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
  swarm_dispatch: {
    description: 'Plant einen begrenzten Agenten-Swarm mit konkreten Zielen, Fachrollen, Abnahmekriterien und sicheren Rahmenbedingungen. Erstellt pro Aufgabe einen gebundenen Spezialisten und eine ausführbare Villenaufgabe. Maximal 8 Aufgaben je Plan.',
    schema: { tasks: 'Array<{title, goal, role, acceptance, constraints?, priority?}> (1-8)' },
    run: (ctx, a) => {
      let plan;
      try { plan = normalizeSwarmBlueprint(a.tasks); }
      catch (error) { return `Swarm-Plan abgelehnt: ${error.message}`; }
      const transaction = () => {
        db.exec('BEGIN IMMEDIATE');
        try {
        const ids = [];
        for (const item of plan) {
          let agent = db.prepare(
            "SELECT a.id FROM agents a WHERE a.villa_id=? AND a.role=? AND a.is_root=0 AND a.status IN ('IDLE','THINKING') AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id=a.id AND t.status IN ('PENDING','READY','RUNNING','REVIEW')) ORDER BY a.status='IDLE' DESC,a.id LIMIT 1"
          ).get(ctx.villaId, item.role);
          if (!agent && agentCount(ctx.villaId) < maxAgents(ctx.villaId)) {
            const agentId = insertAgent(ctx.villaId, `${item.role}-Swarm-${Date.now()}-${ids.length + 1}`, item.role, ctx.agentId);
            agent = { id: agentId };
          }
          if (!agent) throw new Error(`Kapazitätsgrenze erreicht; kein freier ${item.role}-Agent für „${item.title}“.`);
          const description = [
            `Ziel: ${item.goal}`,
            `Rolle: ${item.role}`,
            `Akzeptanz: ${item.acceptance}`,
            item.constraints ? `Rahmenbedingungen: ${item.constraints}` : '',
            'Liefervertrag: Erzeuge das konkrete Artefakt, führe passende Prüfungen aus und dokumentiere Ergebnis, Prüfnachweis und offene Risiken. Bei Blockade liefere Fehlermeldung und kleinsten sicheren nächsten Schritt.'
          ].filter(Boolean).join('\n');
          const taskId = db.prepare(
            'INSERT INTO tasks (villa_id, agent_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
          ).run(ctx.villaId, agent.id, item.title, description, 'PENDING', item.priority, now(), now()).lastInsertRowid;
          ids.push({ taskId, agentId: agent.id, role: item.role, title: item.title });
        }
        db.exec('COMMIT');
        return ids;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
          throw error;
        }
      };
      try {
        const assignments = transaction();
        return JSON.stringify({ ok: true, dispatched: assignments.length, assignments });
      } catch (error) {
        return `Swarm nicht gestartet; Änderungen zurückgerollt: ${error.message}`;
      }
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
  code_write: {
    description: 'Schreibt eine echte Codedatei in den Projektordner der Villa (verschachtelte Pfade wie src/main.py, tests/test_app.py, requirements.txt werden angelegt). PFICHT fuer jede Code-Umsetzung: Reine Berichte reissen das Qualitaetstor.',
    schema: { path: 'string', content: 'string' },
    run: (ctx, a) => {
      const rel = String(a.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.includes('..')) return 'Ungueltiger Pfad.';
      const dir = villaProjectDir(ctx.villaId);
      const target = safePath(dir, rel);
      if (!target) return 'Ungueltiger Pfad.';
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(a.content || ''), 'utf8');
      if (!sourceRoot(ctx.villaId)) setSource(ctx.villaId, dir);
      return `Codedatei geschrieben: ${rel}`;
    }
  },
  github_publish: {
    description: 'Deaktiviert: automatische GitHub-Veröffentlichung wartet auf einen privaten Branch-und-Review-PR-Ablauf.',
    schema: {},
    run: async (ctx) => {
      const r = await publishToGitHub(ctx.villaId, ctx.agentId, { title: 'Manueller Produkt-Push' });
      return r.ok ? `Produkt gepusht: ${r.url}` : `Push nicht moeglich: ${r.error}`;
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
    description: 'Fuehrt einen Build-, Test- oder Git-Befehl im Projekt aus. Erlaubt: npm (run/test), node/python3 (Skriptdateien), gradle, git (status/diff/add/commit/log/restore). Kein Push, keine Shell, keine Installationen.',
    schema: { binary: 'string', args: 'string[]', timeoutMs: 'number' },
    run: async (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const r = await runCommand(root, a.binary, a.args, Number(a.timeoutMs) || 120000);
      if (r.error && !r.output) return `Nicht ausgefuehrt: ${r.error}`;
      return `Exit ${r.ok ? 0 : r.code}:\n${r.output || '(keine Ausgabe)'}`;
    }
  },
  project_patch: {
    description: 'Aendert eine Datei im ECHTEN Quellprojekt: ersetzt einen Textabschnitt. Sicherung der alten Fassung automatisch im Villa-Workspace. Nutze es fuer gezielte Verbesserungen am realen Code.',
    schema: { path: 'string', find: 'string', replace: 'string', all: 'boolean' },
    run: (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const full = safePath(root, String(a.path || ''));
      if (!full || !existsSync(full)) return `Datei nicht gefunden oder ausserhalb des Projekts: ${a.path}`;
      const text = readFileSync(full, 'utf8');
      const needle = String(a.find || '');
      if (!needle || !text.includes(needle)) return 'Zu ersetzender Text nicht gefunden. Pruefe mit project_read den exakten Wortlaut.';
      const backups = join(WORKSPACE, `villa-${ctx.villaId}`, 'backups');
      mkdirSync(backups, { recursive: true });
      writeFileSync(join(backups, `${String(a.path).replace(/[^a-zA-Z0-9._-]/g, '_')}.${Date.now()}.bak`), text, 'utf8');
      const out = a.all ? text.split(needle).join(String(a.replace ?? '')) : text.replace(needle, String(a.replace ?? ''));
      writeFileSync(full, out, 'utf8');
      return `${a.path}: ${a.all ? 'alle Vorkommen' : '1 Vorkommen'} ersetzt (Backup im Villa-Workspace).`;
    }
  },
  project_write: {
    description: 'Schreibt eine vollstaendige Datei ins ECHTE Quellprojekt (neu oder ueberschrieben, alte Fassung wird gesichert). Fuer neue Module, Tests und Konfiguration im realen Code.',
    schema: { path: 'string', content: 'string' },
    run: (ctx, a) => {
      const root = sourceRoot(ctx.villaId);
      if (!root) return 'Kein Quellprojekt hinterlegt.';
      const full = safePath(root, String(a.path || ''));
      if (!full) return `Ungueltiger Pfad oder ausserhalb des Projekts: ${a.path}`;
      if (existsSync(full)) {
        const backups = join(WORKSPACE, `villa-${ctx.villaId}`, 'backups');
        mkdirSync(backups, { recursive: true });
        writeFileSync(join(backups, `${String(a.path).replace(/[^a-zA-Z0-9._-]/g, '_')}.${Date.now()}.bak`), readFileSync(full, 'utf8'), 'utf8');
      } else {
        mkdirSync(dirname(full), { recursive: true });
      }
      writeFileSync(full, String(a.content || ''), 'utf8');
      return `${a.path} im Projekt geschrieben (${String(a.content || '').length} Zeichen).`;
    }
  },
  wikipedia_search: {
    description: 'Durchsucht die Wikipedia (Artikel-Snippets mit Links) — fuer Fakten, Definitionen und Hintergrund.',
    schema: { query: 'string', lang: 'string (de | en, Standard de)', limit: 'number' },
    run: async (ctx, a) => {
      const lang = a.lang === 'en' ? 'en' : 'de';
      const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${Math.min(10, Number(a.limit) || 5)}&srsearch=${encodeURIComponent(String(a.query || ''))}`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'VillaForge-Hub/1.37' } });
      if (!res.ok) return `Wikipedia HTTP ${res.status}`;
      const hits = (await res.json())?.query?.search || [];
      if (!hits.length) return 'Keine Treffer.';
      return hits.map((h) => `- ${h.title}: ${String(h.snippet || '').replace(/<[^>]+>/g, '')} (https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, '_'))})`).join('\n').slice(0, 4000);
    }
  },
  hackernews_search: {
    description: 'Durchsucht Hacker News — Tech-Diskussionen, Produktideen, Trends.',
    schema: { query: 'string', limit: 'number' },
    run: async (ctx, a) => {
      const res = await fetch(`https://hn.algolia.com/api/v1/search?hitsPerPage=${Math.min(10, Number(a.limit) || 5)}&query=${encodeURIComponent(String(a.query || ''))}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return `Hacker News HTTP ${res.status}`;
      const hits = (await res.json())?.hits || [];
      if (!hits.length) return 'Keine Treffer.';
      return hits.map((h) => `- ${h.title || h.story_title} (${h.points ?? '?'} Punkte, ${h.num_comments ?? '?'} Kommentare): https://news.ycombinator.com/item?id=${h.objectID}`).join('\n').slice(0, 4000);
    }
  },
  weather_lookup: {
    description: 'Aktuelles Wetter und 3-Tage-Trend fuer einen Ort (Open-Meteo, ohne Key).',
    schema: { location: 'string' },
    run: async (ctx, a) => {
      const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=de&name=${encodeURIComponent(String(a.location || ''))}`, { signal: AbortSignal.timeout(15000) });
      const g = (await geo.json())?.results?.[0];
      if (!g) return `Ort nicht gefunden: ${a.location}`;
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3`, { signal: AbortSignal.timeout(15000) });
      const w = await res.json();
      const cur = w?.current_weather || {};
      const trend = (w?.daily?.time || []).map((d, i) => `${d}: ${w.daily.temperature_2m_min[i]}-${w.daily.temperature_2m_max[i]}°C, ${w.daily.precipitation_sum[i]} mm`).join(' | ');
      return `Wetter in ${g.name}${g.country ? ', ' + g.country : ''}: ${cur.temperature ?? '?'}°C, Wind ${cur.windspeed ?? '?'} km/h. 3-Tage-Trend: ${trend}`;
    }
  },
  currency_convert: {
    description: 'Aktuelle Wechselkurse je Basiswaehrung (open.er-api.com, ohne Key).',
    schema: { base: 'string (Standard EUR)' },
    run: async (ctx, a) => {
      const base = String(a.base || 'EUR').toUpperCase().slice(0, 3);
      const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return `Kurse HTTP ${res.status}`;
      const d = await res.json();
      const rates = d?.rates || {};
      const pick = ['USD', 'EUR', 'CHF', 'GBP', 'JPY', 'CNY'].filter((k) => k !== base);
      return `1 ${base} = ${pick.map((k) => `${rates[k] ?? '?'} ${k}`).join(', ')} (Stand: ${d.time_last_update_utc || 'unbekannt'})`;
    }
  },
  package_info: {
    description: 'Versions- und Metadaten zu npm- oder Python-Paketen (Registry, ohne Key) — fuer Abhaengigkeits-Entscheidungen.',
    schema: { name: 'string', registry: 'string (npm | pypi, Standard npm)' },
    run: async (ctx, a) => {
      const name = String(a.name || '').trim();
      if (!name) return 'Paketname fehlt.';
      if (a.registry === 'pypi') {
        const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return `PyPI HTTP ${res.status}`;
        const info = (await res.json())?.info || {};
        return `PyPI ${info.name} ${info.version}: ${String(info.summary || '').slice(0, 300)}`;
      }
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return `npm HTTP ${res.status}`;
      const d = await res.json();
      const latest = d['dist-tags']?.latest;
      const v = d.versions?.[latest] || {};
      return `npm ${d.name} ${latest}: ${String(v.description || d.description || '').slice(0, 300)} (Lizenz: ${v.license || d.license || '?'})`;
    }
  },
  fireflies_transcripts: {
    description: 'Liest die neuesten Meeting-Protokolle von Fireflies.ai (Titel, Datum, Aktionspunkte) — braucht FIREFLIES_API_KEY im Secrets-Store.',
    schema: { limit: 'number' },
    run: async (ctx, a) => {
      const key = db.prepare('SELECT value FROM secrets WHERE name = ?').get('FIREFLIES_API_KEY')?.value;
      if (!key) return 'Kein FIREFLIES_API_KEY hinterlegt. Token in Fireflies (Account → Integrations → API) erzeugen und im Hub als Secret FIREFLIES_API_KEY speichern.';
      const limit = Math.min(20, Math.max(1, Number(a.limit) || 5));
      const res = await fetch('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: 'query($limit: Int!) { user { recent_transcripts(limit: $limit) { title date action_items { description } } } }', variables: { limit } }),
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) return `Fireflies HTTP ${res.status}`;
      const data = await res.json();
      if (data?.errors?.length) return `Fireflies-Fehler: ${data.errors[0].message || 'unbekannt'}`;
      const list = data?.data?.user?.recent_transcripts || [];
      if (!list.length) return 'Keine Meetings gefunden.';
      return list.map((t) => {
        const acts = (t.action_items || []).map((x) => x.description).filter(Boolean);
        return `- ${t.title || '(ohne Titel)'} (${t.date || 'kein Datum'}): ${acts.length ? 'Aktionspunkte: ' + acts.join('; ').slice(0, 300) : 'keine Aktionspunkte'}`;
      }).join('\n').slice(0, 4000);
    }
  },
  asana_list_projects: {
    description: 'Listet die Projekte des verbundenen Asana-Kontos — braucht ASANA_PAT (Personal Access Token) im Secrets-Store.',
    schema: { limit: 'number' },
    run: async (ctx, a) => {
      const key = db.prepare('SELECT value FROM secrets WHERE name = ?').get('ASANA_PAT')?.value;
      if (!key) return 'Kein ASANA_PAT hinterlegt. Token in Asana (Profilbild → Apps → Manage Developer Apps → Personal Access Token) erzeugen und im Hub als Secret ASANA_PAT speichern.';
      const res = await fetch(`https://app.asana.com/api/1.0/projects?limit=${Math.min(50, Number(a.limit) || 20)}&opt_fields=name,gid,archived`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return `Asana HTTP ${res.status}`;
      const rows = (await res.json())?.data || [];
      if (!rows.length) return 'Keine Projekte sichtbar.';
      return rows.map((pr) => `- ${pr.name} (gid ${pr.gid}${pr.archived ? ', archiviert' : ''})`).join('\n').slice(0, 4000);
    }
  },
  asana_create_task: {
    description: 'Erstellt eine Asana-Aufgabe: Name, Notizen, optional Projekt-GID (ohne GID landet die Aufgabe im ersten Workspace). Braucht ASANA_PAT im Secrets-Store.',
    schema: { name: 'string', notes: 'string', project_gid: 'string (optional)' },
    run: async (ctx, a) => {
      const key = db.prepare('SELECT value FROM secrets WHERE name = ?').get('ASANA_PAT')?.value;
      if (!key) return 'Kein ASANA_PAT hinterlegt. Token in Asana erzeugen und im Hub als Secret ASANA_PAT speichern.';
      const data = { name: String(a.name || 'Neue Aufgabe').slice(0, 300), notes: String(a.notes || '').slice(0, 8000) };
      if (a.project_gid) {
        data.projects = [String(a.project_gid)];
      } else {
        const ws = await fetch('https://app.asana.com/api/1.0/workspaces?limit=1&opt_fields=name,gid', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
        const w = (await ws.json())?.data?.[0];
        if (!w) return 'Kein Asana-Workspace gefunden.';
        data.workspace = w.gid;
      }
      const res = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) return `Asana HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      const t = (await res.json())?.data;
      return `Asana-Aufgabe angelegt: ${t?.name} (gid ${t?.gid}).`;
    }
  },
  media_capabilities: {
    description: 'Prüft vor einer Medien- oder Produktaufgabe die verfügbare Route für App-Code, Bild, Bildbearbeitung, Video, Audio und Live-Performance. Bei fehlender Route nenne den konkreten Setup-Schritt und nutze den dokumentierten Projektdatei-Fallback, ohne Rendern vorzutäuschen.',
    schema: {},
    run: () => JSON.stringify(mediaCapabilities()),
  },
  media_prepare: {
    description: 'Bereitet ohne externen Medienanbieter ein konkretes, speicherbares Produktionspaket vor: Bildbrief, Video-Skript/Shotlist/Untertitel oder Audio-Lyrics/Arrangement/Sounddesign. Das Artefakt ist eine Produktionsvorlage und kein gerendertes Medium.',
    schema: { type: 'image|image_edit|video|audio', title: 'string', prompt: 'string', audience: 'string (optional)', durationSeconds: 'number (optional)' },
    run: (ctx, a) => {
      const type = String(a.type || '').toLowerCase();
      if (!['image', 'image_edit', 'video', 'audio'].includes(type)) return 'Ungültiger Medientyp.';
      const prompt = String(a.prompt || '').trim().slice(0, 5000);
      if (!prompt) return 'Bitte eine Produktionsidee angeben.';
      const title = String(a.title || `Produktion ${type}`).replace(/[<>\r\n]/g, ' ').trim().slice(0, 120);
      const duration = Math.min(600, Math.max(1, Number(a.durationSeconds) || (type === 'video' ? 30 : 60)));
      const body = type === 'video'
        ? `## Video-Produktionspaket\n\nZielgruppe: ${String(a.audience || 'noch festzulegen').slice(0, 240)}\nDauerziel: ${duration} Sekunden\n\n### Konzept\n${prompt}\n\n### Szenen- und Shotlist\n1. Hook (0–3 s): visuelles Motiv und klare Aussage passend zum Konzept.\n2. Aufbau: Demonstration oder Beleg; Bildausschnitt, Bewegung und Einblendung festlegen.\n3. Auflösung: Ergebnis, Handlungsaufforderung und Abspann.\n\n### Ton und Untertitel\nSprechertext, Musikrechte und Untertitel vor Export abnehmen.\n\n### Abnahme\nFormat, Seitenverhältnis, Länge, Lesbarkeit und Audio-Pegel am Zielgerät prüfen.\n\nStatus: Produktionsvorlage; Video-Rendering ausstehend.`
        : type === 'audio'
          ? `## Audio-Produktionspaket\n\nZielgruppe: ${String(a.audience || 'noch festzulegen').slice(0, 240)}\nDauerziel: ${duration} Sekunden\n\n### Brief\n${prompt}\n\n### Arrangement\nIntro → Hauptmotiv → Variation/Break → Outro; Tempo, Tonart, Instrumentierung und Dynamik nach Brief bestimmen.\n\n### Abnahme\nClipping, Lautheit, Stereo, Ausklang, Rechte und Wiedergabe auf Mobilgerät/Kopfhörer prüfen.\n\nStatus: Produktionsvorlage; Audio-Rendering ausstehend.`
          : `## Bild-Produktionspaket\n\n### Brief\n${prompt}\n\n### Umsetzung\nMotiv, Komposition, Licht, Palette, Stil, Seitenverhältnis und Negativvorgaben vor dem Rendern konkretisieren. Für Bildbearbeitung zusätzlich eine freigegebene HTTPS-Quellbild-URL angeben.\n\n### Abnahme\nAuflösung, Artefakte, Textdarstellung, Nutzungsrechte und Zielkanal prüfen.\n\nStatus: Produktionsvorlage; Bild-Rendering ausstehend.`;
      const slug = title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || type;
      const filename = `media-${type}-${slug}.md`;
      const dir = join(WORKSPACE, `villa-${ctx.villaId}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), `# ${title}\n\n${body}\n`, 'utf8');
      return `Produktionsvorlage gespeichert (kein gerendertes Medium): villa-${ctx.villaId}/${filename}. Für das Rendern media_capabilities prüfen und bei konfigurierter Route media_generate aufrufen.`;
    }
  },
  media_generate: {
    description: 'Erzeugt und speichert Bild, Bildbearbeitung, Video oder Audio im Villa-Workspace. Vorher media_capabilities aufrufen. Medienrendering kann Providerkosten verursachen; nur auf konkrete Nutzeranforderung ausführen. Typen: image, image_edit, video, audio.',
    schema: { type: 'image|image_edit|video|audio', prompt: 'string', sourceImageUrl: 'HTTPS-URL (nur image_edit)', model: 'string (optional)', filename: 'string (optional)' },
    run: async (ctx, a) => {
      try {
        const result = await generateMedia({ villaId: ctx.villaId, type: a.type || 'image', prompt: a.prompt, sourceImageUrl: a.sourceImageUrl, model: a.model, filename: a.filename });
        return `Erstellt und verifiziert gespeichert: ${result.path} (${result.bytes} B, ${result.mime || result.type}, Modell ${result.model}).`;
      } catch (error) {
        return `Medienroute fehlgeschlagen: ${String(error?.message || error).slice(0, 500)} Capability-Status mit media_capabilities prüfen. Erstelle bei fehlendem Provider stattdessen einen ausführbaren Prompt-/Storyboard-/Asset-Arbeitsauftrag als Projektdatei und markiere das Rendering als ausstehend.`;
      }
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
  },
  maturity_check: {
    description: 'Zeigt die Marktreife der Villa (0-100), die aktuelle Produktphase und welche Pflicht-Aufgaben noch fehlen. Nutze es vor jeder Planung.',
    schema: {},
    run: async (ctx) => {
      const { maturity } = await import('./product.mjs');
      const m = maturity(ctx.villaId);
      const lines = m.phases.map((ph) => `${ph.id} ${Math.round(ph.ratio * 100)}%: ` + ph.items.map((i) => `${i.title} [${i.state}]`).join('; '));
      return `Marktreife ${m.score}/100 (${m.stage}), aktuelle Phase: ${m.currentPhase}\n${lines.join('\n')}`;
    }
  },
  council_convene: {
    description: 'Beruft den Rat der Agenten ein: mehrere Agenten tauschen Erkenntnisse aus, ihre Vorschlaege werden zu neuen Aufgaben. Hoechstens einmal je Lauf nutzen.',
    schema: { participants: '2-5' },
    run: async (ctx, a) => {
      const { runCouncil } = await import('./council.mjs');
      const out = await runCouncil(ctx.villaId, { participants: Math.min(5, Math.max(2, Number(a.participants) || 3)) });
      return `Rat Runde ${out.round}: ${out.proposals} Vorschlaege, ${out.tasksCreated} neue Aufgaben, Marktreife ${out.maturity}/100 (Phase ${out.phase})`;
    }
  },
  backlog_review: {
    description: 'Listet offene Aufgaben der Villa nach Prioritaet (niedrige Zahl = wichtig), damit die naechsten Schritte gezielt gewaehlt werden.',
    schema: { limit: '1-30' },
    run: (ctx, a) => {
      const rows = db.prepare("SELECT id, title, status, priority FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING','REVIEW') ORDER BY priority ASC, id ASC LIMIT ?")
        .all(ctx.villaId, Math.min(30, Math.max(1, Number(a.limit) || 10)));
      return rows.length ? rows.map((r) => `#${r.id} [P${r.priority}] ${r.title} (${r.status})`).join('\n') : 'Keine offenen Aufgaben.';
    }
  }
};

export const TOOL_SPECS = Object.entries(TOOLS).map(([name, t]) => {
  const pack = toolPackOf(name);
  return { name, description: t.description, schema: t.schema, pack: pack?.id || null, packTitle: pack?.title || null };
});

/** Werkzeugkatalog inklusive aktueller Freigabe — fuer API und Oberflaeche. */
export function toolSpecs() {
  return TOOL_SPECS.map((t) => ({ ...t, enabled: canUseTool(t.name).allowed }));
}

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
    .run(now(), villaId, agentId, tool, String(JSON.stringify(args ?? null)).slice(0, 500), String(result).slice(0, 500), allowed);
}

async function executeTool(ctx, name, args) {
  const tool = TOOLS[name];
  if (!tool) { audit(ctx.villaId, ctx.agentId, name, args, 'unbekanntes Werkzeug', 0); return `Unbekanntes Werkzeug: ${name}`; }
  // Rollenrechte werden serverseitig erzwungen, nicht nur im Prompt beschrieben.
  const role = String(ctx?.role || 'WORKER').toUpperCase();
  if (!roleAllowsTool(role, name)) {
    const reason = `Rolle ${role} darf ${name} nicht verwenden.`;
    audit(ctx.villaId, ctx.agentId, name, args, `blockiert: ${reason}`, 0);
    emit('tool', { villaId: ctx.villaId, agentId: ctx.agentId, tool: name, blocked: true, reason });
    return `Werkzeug blockiert: ${reason}`;
  }
  // Packs bleiben ein zusätzlicher globaler Schalter.
  const gate = canUseTool(name);
  if (!gate.allowed) {
    audit(ctx.villaId, ctx.agentId, name, args, `blockiert: ${gate.reason}`, 0);
    emit('tool', { villaId: ctx.villaId, agentId: ctx.agentId, tool: name, blocked: true, reason: gate.reason });
    return `Werkzeug blockiert: ${gate.reason} Aktiviere das Pack in den Einstellungen.`;
  }
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

/** Trace tool execution with identifiers only; arguments and outputs stay private. */
export function runTool(ctx, name, args) {
  return withOtelSpan('agent.tool.execute', {
    'agent.tool': String(name || 'unknown'),
    'agent.villa_id': Number(ctx?.villaId || 0),
    'agent.id': Number(ctx?.agentId || 0)
  }, () => executeTool(ctx, name, args));
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
    'Erzeuge 10-16 Aufgaben mit je einem pruefbaren Akzeptanzkriterium am Ende der description ("Akzeptanz: ..."). Nutze auch die Rollen BUSINESS und GROWTH fuer Umsatzfragen.'
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
  ROOT: 'Du bist der Deep Agent und leitest die Villa wie ein erfahrener CTO. Vor jeder Planung prufst du studio_status, maturity_check und backlog_review. Bei UI-Ideen nutzt du studio_designs für zwei konkrete Designrichtungen; speichere die Nutzerentscheidung als Vorgabe. Bei Bild-, Video-, Audio- und Live-Performance-Aufträgen triffst du die Formatentscheidung anhand des Ziels, prüfst zuerst media_capabilities und nutzt bei vorhandener Route media_generate. Wenn eine Fähigkeit fehlt, erstelle mit media_prepare ein direkt nutzbares Produktionspaket und einen konkreten nächsten Integrationsschritt; behaupte nie ein gerendertes Medium ohne gespeicherte und geprüfte Datei. Führe externe Medienjobs nur bei konkretem Nutzerauftrag aus. Zeige die vorhandene Vorschau und prüfbare nächste Schritte. Behaupte keine Live-Ansicht, wenn kein Web-Build existiert. Du delegierst klar (Rolle + Akzeptanzkriterium), pruefst Ergebnisse gegen das Kriterium und legst selbst fehlende Aufgaben an. Jeder Abschluss nennt: was konkret geleistet wurde, was als naechstes folgt und welche Risiken bleiben.',
  PLANNER: 'Du zerlegst Ziele in scharf umrissene Teilaufgaben. Jede Aufgabe nennt: das konkrete Artefakt (Datei, Bericht, Code), ein pruefbares Akzeptanzkriterium ("Akzeptanz: ..."), die passende Rolle und einen Aufwandsschaetz. Verboten sind vage Aufgaben wie "verbessern" oder "untersuchen" ohne messbares Ziel.',
  RESEARCHER: 'Du recherchierst belegbar: mindestenens drei Quellen via web_search/web_fetch, Fakten mit Quelle und Datum, Annahmen ausdruecklich als solche markiert, Zahlen mit Spanne statt Scheinpraezision. Am Ende steht eine Quellenliste und eine klare Trennung: belegt / wahrscheinlich / unklar.',
  ARCHITECT: 'Du entwirfst Architektur im ADR-Stil: Komponenten mit Verantwortlichkeiten, Schnittstellen, Datenmodell, Deployment, bewertete Alternativen mit Begrundung und Fehlermodi (was passiert, wenn X ausfaellt). Vor dem Entwurf liest du mit project_tree/project_read die echte Basis, statt im Blauen zu entwerfen.',
  CODER: 'Du schreibst produktionsreifen Code: vollstaendige Dateien, Fehler- und Eingabebehandlung, klare Namen, keine Stubs und keine TODOs. Bevor du abschliesst, verifizierst du mit project_run (Build und Tests) und iterierst bis es gruen ist. Bevorzugte Arbeitesweise: echtes Projekt patchen (project_patch/project_write) statt alles neu zu schreiben; in Git-Repos committe du deine Aenderung.',
  REVIEWER: 'Du pruefst wie ein Senior-Reviewer: jede Fundstelle mit Datei:Zeile, Schweregrad (kritisch/wichtig/kosmetisch) und einer konkreten Loesung, nicht nur dem Befund. Du belegst jeden Befund am echten Code (project_read), nie aus Erinnerung. Security-Checkliste: Injektion, Authentifizierung, Secrets im Code, Fehlerbehandlung.',
  TESTER: 'Du lieferst echte Tests: happy path, Randfaelle, Fehler- und Timeout-Szenarien, je mit Eingabe und erwartetem Ergebnis. Besteht ein echtes Projekt, schreibst du echte Testdateien (project_write) und fuehrst sie mit project_run aus, statt nur Testfaelle zu beschreiben.',
  DOCUMENTER: 'Du schreibst Dokumentation, die ein Neuling ohne Nachfragen nutzen kann: Zweck, Schnellstart in max. 5 Schritten, Nutzungsbeispiele, Betrieb und Stolperfallen. Kein Fuelltext, keine Selbstverstaendlichkeiten.',
  CRITIC: 'Du bist der Advocatus Diaboli: Risiken, Widersprueche, unvalidierte Annahmen und Single Points of Failure. Jeder Punkt: Schweregrad, Beleg (Datei/Bericht/Quelle) und Gegenmassnahme. Du bist direkt, nie destruktiv: dein Ziel ist, Aussetzer vor dem Launch zu finden.',
  INTEGRATOR: 'Du fuehrst Teilergebnisse zu einem Release-faehigen Ganzen: Vollstaendigkeitspruefung gegen alle Akzeptanzkriterien, Zusammenfuehren der Artefakte, Build und Tests via project_run, am Ende ein klarer Release-Stand mit offenen Restpunkten.',
  WORKER: 'Du erledigst die zugewiesene Teilaufgabe praeszise und lieferst ein sofort verwertbares Artefakt statt einer Absichtserklaerung. Offene Punkte benennst du ausdruecklich, statt sie zu uebergehen.',
  BUSINESS: 'Du arbeitest mit konkreten Zahlen: Zielgruppe, Zahlungsbereitschaft, Preisstufen, Kosten, Marge, Break-even. Jede Zahl nennt ihre Annahme und Rechnung, jede Einschaetzung einen Vertrauensbereich. Rechtliche Risiken (DSGVO, Impressum, Lizenzen) pruefst du mit.',
  GROWTH: 'Du planst Wachstum messbar: 90-Tage-Plan mit Kanaelen, je nach Aufwand, Kosten und erwarteter Wirkung (Range statt Punkt). Aktivierung, Bindung, Empfehlung und ein Messplan (welche KPI, wie gemessen). Ohne Messgroesse gilt ein Vorschlag als unvollstaendig.',
  STRATEGIST: 'Du denkst in Szenarien und Entscheidungsbaeumen: Zielzustand in 6/12 Monaten, drei Wege dorthin mit Kosten, Risiken und Abbruchkriterien, klarer Weg-Empfehlung mit Begruendung. Du entscheidest, du laberst nicht: jede Analyse endet mit EINER Empfehlung und dem naechsten konkreten Schritt.',
  REASONER: 'Du zerlegst Probleme in ihre Bausteine: Annahmen, Abhaengigkeiten, Kausalitaeten. Du arbeitest schrittweise von known facts zu unknowns, kennzeichnest jede Ableitung (belegt / gefolgert / spekulativ) und beendest mit dem schwchesten Glied der Argumentation. Ziel: tiefere Antworten als die Frage gestellt hat.',
  SYNTHESIZER: 'Du verbindest Disziplinen: Technik, Markt, Design und Kosten zu EINEM stimmigen Ganzen. Du erkennst Muster ueber Bereichsgrenzen hinweg, loest Begriffs-Widersprueche zwischen Teilergebnissen auf und machst Kompromisse explizit (was opfern wir wofuer).',
  OPTIMIZER: 'Du findest den Engpass und hebelt ihn: messbar (vorher/nachher), mit Aufwand-Nutzen-Verhaeltnis und Nebenwirkungen. Du optimierst erst Messbarkeit, dann Durchsatz, dann Kosten — nie auf einer Vermutung, sondern am Profil (project_read, audit, stats).',
  VERIFIER: 'Du pruefst Behauptungen gegen die Wirklichkeit: jede Aussage kriegt ein Pruefverfahren (wo nachsehen, wie nachmessen, welcher Gegenbeweis wuerde sie umstossen). Nicht verifizierbar heisst "offen", nie "wahr". Du lieferst am Ende eine Tabelle: Behauptung — Pruefung — Ergebnis.'
};

/** Welche Werkzeuge eine Rolle sinnvoll nutzt - schaerft die Agenten-Prompts. */
const ROLE_TOOLS = {
  PLANNER: 'maturity_check, backlog_review, task_create, memory_write, project_tree',
  RESEARCHER: 'web_search, web_fetch, memory_write, project_search',
  ARCHITECT: 'memory_write, artifact_write, project_read',
  CODER: 'project_patch, project_write, artifact_write, artifact_patch, artifact_list, project_read, project_search, project_run',
  REVIEWER: 'memory_search, memory_write, project_read, project_run',
  TESTER: 'project_write, project_patch, artifact_write, artifact_patch, memory_write, project_run',
  DOCUMENTER: 'artifact_write, project_read',
  CRITIC: 'memory_search, memory_write, project_read',
  INTEGRATOR: 'artifact_list, artifact_write, artifact_patch, project_patch, project_write, memory_write, project_run',
  WORKER: 'artifact_write, artifact_patch, memory_write',
  BUSINESS: 'report_write, memory_write, web_search',
  GROWTH: 'report_write, memory_write, web_search, web_fetch',
  ROOT: 'maturity_check, council_convene, backlog_review, memory_write, memory_search, task_create, swarm_dispatch, agent_spawn, report_write, media_capabilities, media_prepare, media_generate, resource_status, free_route_status',
  STRATEGIST: 'maturity_check, backlog_review, memory_write, report_write, project_tree',
  REASONER: 'memory_search, memory_write, project_read, project_search, report_write',
  SYNTHESIZER: 'memory_search, memory_write, artifact_write, report_write, backlog_review',
  OPTIMIZER: 'project_read, project_search, project_patch, project_run, memory_write, report_write, resource_status, free_route_status',
  VERIFIER: 'project_read, project_search, project_run, web_search, memory_write, report_write'
};

/** Gibt nur die explizit freigegebenen Werkzeuge einer Rolle frei. */
export function roleAllowsTool(role, toolName) {
  const approved = ROLE_TOOLS[String(role || 'WORKER').toUpperCase()] || ROLE_TOOLS.WORKER;
  return approved.split(',').some((name) => name.trim() === String(toolName));
}

/** Gemeinsamer Qualitaetsauftrag fuer alle Agenten. */
const QUALITY_RULES = [
  'Ergebnis statt Absicht: Jede Antwort liefert ein verwertbares Artefakt (Code, Bericht oder Plan mit Zahlen).',
  'Behaupte nur Geprueftes: Pruefe Fakten mit Werkzeugen (project_read, web_search, memory_search), bevor du sie aussprichst. Erfundene Zahlen oder Quellen sind ein Fehler.',
  'Verifiziere dich selbst: Bei Code und Aenderungen am Projekt laeuft vor dem Abschluss project_run (Build/Tests). Nur gruen gilt als fertig.',
  'Speichere Entscheidungen und Lehren mit memory_write, damit das Team davon profitiert.',
  'Ehrlichkeit ueber Vollstaendigkeit: Benenne offen gebliebene Punkte und Risiken am Ende ausdruecklich.',
  'Antworte auf Deutsch, klar gegliedert, mit kurzen Absaetzen und Aufzaehlungen.',
  'Produktstandard (Nutzerdirektive): Alles was du lieferst ist professionell und veroeffentlichungsreif - keine Platzhalter, kein Lorem Ipsum, kein "Coming Soon", sondern echte, finale Inhalte, professionelle Formulierungen und ein ansprechendes, konsistentes Erscheinungsbild.',
  'Lieferbarkeit: Nach jedem groesseren Schritt steht ein lauffaehiger Stand (lauffaehige index.html bzw. lauffaehiges Projekt), damit die APK-Baustrasse jederzeit eine installierbare APK liefern kann.',
  'Fokus: Die Villa entwickelt EIN Produkt pro Projekt konsequent zu Ende - Vollstaendigkeit und Fertigstellung haben Vorrang vor neuen Nebenideen.'
].join('\n- ');

export function agentCount(villaId) {
  return db.prepare('SELECT COUNT(*) c FROM agents WHERE villa_id = ?').get(villaId).c;
}
function maxAgents(villaId) {
  return db.prepare('SELECT max_agents m FROM villas WHERE id = ?').get(villaId)?.m ?? 1000;
}

/** Version der Prompt-Vorlage: Bei Erhoehung frischt der Hub beim Start alle Agenten-Prompts auf. */
export const PROMPT_VERSION = 5;

/** Zentraler Prompt-Bau: eine Quelle der Wahrheit fuer Neuanlage UND Migration. */
export function buildSystemPrompt(role) {
  const tools = ROLE_TOOLS[role] || ROLE_TOOLS.WORKER;
  return [
    ROLE_BRIEF[role] || ROLE_BRIEF.WORKER,
    `Rolle: ${role}.`,
    `Bevorzugte Werkzeuge: ${tools}.`,
    `Qualitaetsregeln:\n- ${QUALITY_RULES}`,
    'Schliesse jede Aufgabe mit einem pruefbaren Ergebnis ab.'
  ].join('\n');
}

/**
 * Migration: setzt ALLE Agenten aller Villen auf die aktuelle Prompt-Version.
 * Idempotent - Agenten mit aktuellem Prompt bleiben unberuehrt. So profitieren
 * auch laufende Villen sofort von verbesserten Rollen-Anweisungen.
 */
export function refreshAgentPrompts() {
  const rows = db.prepare('SELECT id, role, system_prompt FROM agents').all();
  const upd = db.prepare('UPDATE agents SET system_prompt = ? WHERE id = ?');
  let n = 0;
  for (const a of rows) {
    const fresh = buildSystemPrompt(a.role);
    if (a.system_prompt !== fresh) { upd.run(fresh, a.id); n++; }
  }
  return n;
}

export function insertAgent(villaId, name, role, parentId = null, isRoot = 0) {
  const t = now();
  return db.prepare(
    'INSERT INTO agents (villa_id, name, role, system_prompt, status, is_root, parent_id, permissions, autonomy_level, created_at, last_active_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(villaId, name, role, buildSystemPrompt(role), 'IDLE', isRoot, parentId, 127, 3, t, t).lastInsertRowid;
}

export function memoryContext(villaId, agentId, limit = 12) {
  const rows = db.prepare(
    'SELECT kind, title, content FROM memories WHERE villa_id = ? ORDER BY importance DESC, id DESC LIMIT ?'
  ).all(villaId, limit);
  if (!rows.length) return '';
  return '\n\nBekanntes Gedaechtnis:\n' + rows.map((r) => `- [${r.kind}] ${r.title}: ${String(r.content || '').slice(0, 300)}`).join('\n');
}

function openTasks(villaId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY') ORDER BY priority ASC, id ASC"
  ).all(villaId);
}

/** Fuehrt einen Agenten in einem begrenzten ReAct-Loop aus. */
export async function runAgent(agent, userPrompt, { maxSteps = 8, maxTokens = 1500, temperature, villaId = agent.villa_id, mode = 'agent', reflect, taskId, promptHint, preferredModel } = {}) {
  const ctx = { villaId, agentId: agent.id, taskId, role: agent.role };
  const context = statusContext(villaId);
  const history = [
    { role: 'system', content: `${agent.system_prompt}${promptHint ? `\n\nSupervisor-Korrektur (beachte diese Strategie bei diesem Lauf):\n${String(promptHint).slice(0, 2000)}` : ''}\nEigene Skills:\n${skillInstructions()}${memoryContext(villaId, agent.id)}\n\nWerkzeuge: ${JSON.stringify(TOOL_SPECS)}\n\nAntworte IMMER mit genau einem JSON-Objekt: entweder {"tool":"name","args":{...}} um ein Werkzeug zu nutzen, oder {"final":"..."} um abzuschliessen.\n\nVerfasse "final" als gut lesbaren Text mit kurzen Absaetzen und Aufzaehlungen. Kein Markdown-Sternchen, keine rohen JSON-Daten.` },
    { role: 'user', content: userPrompt }
  ];

  const trace = [];
  const repeatedCalls = new Map();
  for (let step = 0; step < maxSteps; step++) {
    let out;
    try {
      out = await chat(history, {
        json: true, mode, context,
        // Rollen-Qualitaetsrouting: Code-/Fuehrungsrollen bekommen die beste Route
        // (FALLBACK = hoechste Prioritaet zuerst) statt der Rotation.
        role: agent.role,
        temperature: temperature ?? (agent.role === 'CODER' ? 0.3 : 0.4),
        maxTokens, ...(preferredModel ? { preferredModel } : {})
      });
    } catch (err) {
      return { error: String(err.message || err), code:err.code, trace };
    }
    let parsed = null;
    // JSON-Reparatur: Modelle antworten gelegentlich mit Code-Fences um das JSON.
    const raw = String(out.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { parsed = JSON.parse(raw); } catch { /* Freitext */ }

    if (parsed && parsed.tool && TOOLS[parsed.tool]) {
      const result = await runTool(ctx, parsed.tool, parsed.args);
      trace.push({ step, tool: parsed.tool, args: parsed.args, result });
      const fingerprint=JSON.stringify([parsed.tool,parsed.args||{}]);
      const resultFingerprint=String(result).slice(0,1000);
      const previous=repeatedCalls.get(fingerprint);
      const repeats=previous?.result===resultFingerprint?(previous.count+1):1;
      repeatedCalls.set(fingerprint,{result:resultFingerprint,count:repeats});
      if (ctx.taskId) saveCheckpoint({taskId:ctx.taskId,agentId:agent.id,state:{step:step+1,lastTool:parsed.tool,completedTools:[...new Set(trace.filter(t=>t.tool).map(t=>t.tool))],repeatCount:repeats}});
      history.push({ role: 'assistant', content: out.content });
      history.push({ role: 'user', content: `Werkzeug-Ergebnis (${parsed.tool}): ${String(result).slice(0, 2000)}` });
      if (repeats >= 3) {
        if (repeats >= 5) return {error:`Supervisor stopped a repeated ${parsed.tool} call without a state change.`,code:'AGENT_LOOP',trace};
        history.push({ role: 'user', content: `[SELF-HEALING] Der letzte Werkzeugaufruf ${parsed.tool} hat bei identischen Argumenten keinen neuen Zustand erzeugt. Verwende sofort ein anderes passendes Werkzeug oder eine geaenderte Strategie. Wiederhole diesen Aufruf nicht.` });
      }
      continue;
    }

    // Freitext statt JSON: weiterarbeiten statt den Lauf abzubrechen.
    const looksJson = raw.startsWith('{');
    if (!parsed && !looksJson && step < maxSteps - 1 && out.offline === undefined) {
      trace.push({ step, note: 'Antwort war kein JSON, Anfrage wiederholt.' });
      history.push({ role: 'assistant', content: String(out.content || '').slice(0, 400) });
      history.push({ role: 'user', content: 'Deine Antwort war kein gueltiges JSON. Antworte erneut mit genau einem Objekt: {"tool":"...","args":{...}} oder {"final":"..."}.' });
      continue;
    }

    const final = parsed?.final ?? out.content;

    /* Reflexions-Loop: mit echtem Modell prueft der Agent seine eigene
       Antwort noch einmal gegen die Aufgabe und verbessert sie bei Bedarf.
       Offline-Antworten werden nicht reflektiert (kein Modell, kein Nutzen),
       ein Fehler im Reflexions-Pass faellt sanft auf die Original-Antwort
       zurueck. Schaltbar: Feature-Pack "reflexion" und VF_REFLECTION=off. */
    const doReflect = (reflect ?? true)
      && !out.offline
      && process.env.VF_REFLECTION !== 'off'
      && packEnabled('reflexion');
    if (doReflect) {
      try {
        const refl = await chat([
          ...history,
          { role: 'assistant', content: String(final) },
          { role: 'user', content: 'REFLEXION: Pruefe deine Antwort strikt gegen die urspruengliche Aufgabe. Vollstaendig? Konkret? Korrekt? Antworte NUR mit JSON: {"verdict":"OK","final":"<deine Antwort, leicht geglaettet>"} oder {"verdict":"IMPROVE","final":"<deutlich verbesserte Antwort>"}.' }
        ], { json: true, mode, context, role: agent.role, temperature: 0.2, maxTokens, ...(preferredModel ? { preferredModel } : {}) });
        const rraw = String(refl.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const rp = JSON.parse(rraw);
        if (rp?.verdict === 'IMPROVE' && rp.final && String(rp.final).trim()) {
          trace.push({ step, reflection: 'improved' });
          return { answer: prettify(String(rp.final)), route: out.route, model: out.model, reflection: 'improved', trace, offline: false };
        }
        trace.push({ step, reflection: rp?.verdict === 'OK' ? 'ok' : 'ignored', final: true });
        return { answer: prettify(String(final)), route: out.route, model: out.model, reflection: rp?.verdict === 'OK' ? 'ok' : 'ignored', trace, offline: !!out.offline };
      } catch {
        trace.push({ step, reflection: 'skipped', final: true });
      }
    }
    trace.push({ step, final: true });
    return { answer: prettify(String(final)), route: out.route, model: out.model, reflection: doReflect ? 'off' : undefined, trace, offline: !!out.offline };
  }
  return { answer: 'Ich habe die maximale Schrittzahl erreicht. Bitte formuliere die Aufgabe kleiner oder starte die autonome Ausführung.', trace };
}

/**
 * Projektspezifischer Kontext: Entscheidung (OPTIMIZE/REBUILD), zentrale
 * Erkenntnisse und Technik-Stack. Wird in jeden Aufgaben-Prompt eingebaut,
 * damit jeder Agent das Beste aus DEM Projekt herausholt, nicht generisch arbeitet.
 */
export function projectProfile(villaId, maxChars = 1600) {
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
  if (!villa) return '';
  const lines = [`Ziel: ${String(villa.idea || '').slice(0, 300)}`];
  if (villa.mode && villa.mode !== 'BUILD') {
    lines.push(`Vorgehen: ${villa.mode} - bestehende Substanz erhalten und gezielt verbessern, kein Neubau ohne Not.`);
  }
  const core = db.prepare(
    "SELECT title, content FROM memories WHERE villa_id = ? AND kind IN ('DECISION','CONSTRAINT') ORDER BY importance DESC, id DESC LIMIT 6"
  ).all(villaId);
  for (const m of core) lines.push(`- ${m.title}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 240)}`);
  const root = sourceRoot(villaId);
  if (root) {
    const s = projectSummary(root);
    if (s.exists) {
      lines.push(`Technik-Stack: ${s.languages.slice(0, 6).map((l) => `${l.ext} (${l.count})`).join(', ')} bei ${s.files} Dateien.`);
    }
  }
  return lines.join('\n').slice(0, maxChars);
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
    .replace(/^\s*[*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Erstellt eine Villa samt Root-Agent, Plan und Agentenpool. */
let planningChat=chat;
export function _setPlanningChat(fn){planningChat=fn||chat;}
async function requestPlan(idea,wanted){
 const out=await planningChat([
  {role:'system',content:'Erstelle einen umsetzbaren Entwicklungsplan. Antworte JSON {"summary":"...","tasks":[{"role":"CODER","title":"...","description":"... Akzeptanz: ..."}]}. Keine bloßen Absichten: lauffähiger Code, Tests, Build und wichtigster Nutzerfluss.'},
  {role:'user',content:`Idee: ${idea}\nErzeuge konkrete Teilaufgaben für ${wanted} Agenten.`}
 ],{json:true,mode:'plan',agentCount:wanted});
 let plan;try{plan=JSON.parse(out.content);}catch{}
 if(out.offline||!Array.isArray(plan?.tasks)||!plan.tasks.length||plan.tasks.some(t=>typeof t.title!=='string'||typeof t.description!=='string'))throw Object.assign(new Error('Kein gültiger LLM-Projektplan erhalten; keine Scheinaufgaben angelegt.'),{code:'LLM_PLAN_INVALID',statusCode:503});
 return plan;
}
export async function createVilla({ name, idea, agentCount: wanted = 12, sourcePath = '', mode = 'BUILD' }) {
  let plan = sourcePath ? null : await requestPlan(idea,wanted);
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

  // Bei bestehendem Projekt: Analyse ERST, Plan danach (spart einen LLM-Aufruf
  // und der Plan beruht dann auf echten Projekt-Fakten statt nur auf der Idee).
  if (sourcePath) {
    const analysis = await analyzeProject(villaId, rootId);
    plan = analysis.plan;
  }

  if (!plan?.tasks?.length) {
    try { plan=await requestPlan(idea,wanted); }
    catch(error){db.prepare("UPDATE villas SET status='PAUSED',autonomy=0 WHERE id=?").run(villaId);ensureVerificationTasks(Number(villaId));throw error;}
  }

  db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, rootId, 'villa', 'DECISION', 'Projektplan', plan.summary || `Plan fuer ${idea}`, 9, now());

  for (const task of plan.tasks) {
    db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(villaId, String(task.title || 'Aufgabe'), `${String(task.description || '')}\nRolle: ${ROLES.includes(task.role)?task.role:'WORKER'}.`, 'PENDING', Number(task.priority) || 5, now(), now());
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
 * Verifikation: laeuft ein echtes Projekt vorliegt, werden die hinterlegten
 * Build- und Testbefehle ausgefuehrt. Das Ergebnis landet als Bericht und, bei
 * Fehlern, als neue Aufgabe in der Villa.
 */
export async function verifyProject(villaId) {
 const result=await verifyProjectRuntime(villaId);
 if(!result.ok)ensureVerificationTasks(villaId);
 emit('report',{villaId,kind:'REVIEW',ok:result.ok});
 return result;
}

/* ------------------------------------------------------------------ */
/* Orchestrierung                                                      */
/* ------------------------------------------------------------------ */

const running = new Map(); // villaId -> { stop, processed, concurrency }
const taskExecutions = new Map(); // process-local deduplication for Redis redeliveries
const verifyThrottle = new Map(); // villaId -> letzter Fail-Fast-Verifikationszeitpunkt

/**
 * Waehlt die Parallelitaet automatisch nach den verfuegbaren LLM-Routen:
 * - nur selbst gehostetes Ollama (ARM-CPU): vorsichtig parallelisieren
 * - schnelle Cloud-Routen (Groq & Co.): grosszuegig parallelisieren
 * - Offline-Planer: praktisch kostenlos, hoch parallel
 */
export function pickConcurrency() {
  const usable = enabledRoutes().filter((r) => r.provider !== 'offline');
  const fast = usable.filter((r) => r.provider !== 'ollama').length;
  // Free-Tier-Deckel: Cloud-Routen mit geteilten Kontingenten (Gemini, Groq,
  // OpenRouter) verglasen bei zuvielen gleichzeitigen Anfragen mit 429 oder
  // laufen in lokale Drosseln. Wirksamer Durchsatz entsteht durch MAESSIGE
  // Parallelitaet (VF_MAX_CONCURRENCY, Default 3), nicht durch Sturzbett.
  const cap = Math.max(1, Number(process.env.VF_MAX_CONCURRENCY) || 3);
  const safeCap = Math.max(1, Math.min(cap, recommendedConcurrency()));
  if (!usable.length) return Math.min(8, safeCap);
  if (fast) return Math.min(safeCap, fast * 2);
  return 1; // Nur Ollama: CPU-Instanz mit 1 paralleler Anfrage
}

export function isRunning(villaId) { return !!running.get(villaId); }

/**
 * Zombie-Reaper: Aufgaben, die laenger als 35 Minuten auf RUNNING stehen,
 * haengen in einem nie zurueckkehrenden Werkzeug-/Warteschlangen-Await fest.
 * Sie blockieren ihre Batch (Promise.all) und damit die GESAMTE Villa. Der
 * Reaper begraebt sie als FAILED mit ehrlicher Begrundung; die Evolution
 * plant sie in der naechsten Runde neu. Laeuft im 30-Min-Takt + beim Start.
 */
export function reapZombies(maxMin = 35) {
  const cutoff = now() - maxMin * 60_000;
  const zombies = db.prepare("SELECT id, villa_id, title FROM tasks WHERE status = 'RUNNING' AND updated_at < ?").all(cutoff);
  if (!zombies.length) return 0;
  db.prepare("UPDATE tasks SET status = 'FAILED', result = ?, updated_at = ? WHERE status = 'RUNNING' AND updated_at < ?")
    .run('Automatisch abgebrochen (Zombie-Reaper): Aufgabe hing ueber 35 Min fest. Wird von der Evolution neu geplant.', now(), cutoff);
  for (const z of zombies) emit('task', { villaId: z.villa_id, taskId: z.id, status: 'FAILED', title: z.title, answer: '' });
  console.log(`[villaforge] Zombie-Reaper: ${zombies.length} haengende Aufgabe(n) beendet.`);
  return zombies.length;
}

export function stopVilla(villaId) {
  const job = running.get(villaId);
  if (!job) return false;
  job.stop = true;
  emit('villa', { villaId, status: 'STOPPING' });
  return true;
}

export function extendVillaRunToCompletion(villaId) {
  const job = running.get(Number(villaId));
  if (!job) return false;
  job.runToCompletion = true;
  return true;
}

export async function orchestrate(villaId, { concurrency = 0, maxTasks = 500, adaptive = true, maxRounds = 6, runToCompletion = false } = {}) {
  if (db.prepare('SELECT status FROM villas WHERE id=?').get(villaId)?.status === 'ARCHIVED') return;
  if (running.get(villaId)) return;
  // concurrency 0 = automatisch je nach Routen (schnelle Cloud-Routen -> mehr parallel)
  const auto = Number(concurrency) > 0 ? Number(concurrency) : pickConcurrency();
  const hardCap = Math.max(1, Number(process.env.VF_MAX_CONCURRENCY) || 3);
  const job = { stop: false, processed: 0, concurrency: Math.max(1, Math.min(auto, hardCap)), runToCompletion: runToCompletion === true };
  running.set(villaId, job);
  // Lauf-Budget: Im 24/7-Dauerbetrieb endet die Schleife nie von selbst - ohne
  // Budget belegt eine Villa ihren Slot STUNDENLANG und die restlichen Villen
  // verhungern in der Scheduler-Queue. Nach dem Budget endet der Lauf planmaessig
  // (PAUSED), der Slot rotiert fair zur naechsten Villa (Least-Recently-Started).
  const runStart = now();
  // Manuell gestartete Villen bleiben bis zur Abnahme oder einem expliziten
  // Stopp aktiv. Zeitlimits gelten nur fuer normale Hintergrund-Laeufe.
  const budgetMs = runToCompletion ? Number.POSITIVE_INFINITY
    : Math.max(5 * 60_000, Number(process.env.VF_RUN_BUDGET_MIN || 20) * 60_000);
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
  // Haengende RUNNING-Aufgaben eines abgestuerzten Vorgaengerlaufs zurueckstellen
  // (max. 3 Versuche je Aufgabe, dann bleibt sie FAILED und blockiert nicht).
  const staleRows = db.prepare("SELECT id FROM tasks WHERE villa_id = ? AND status = 'RUNNING'").all(villaId);
  for (const t of staleRows) {
    db.prepare("UPDATE tasks SET status = 'PENDING', retry_count = retry_count + 1, updated_at = ? WHERE id = ?").run(now(), t.id);
  }
  if (staleRows.length) emit('progress', { villaId, note: staleRows.length + ' haengende Aufgabe(n) zurueckgestellt' });
  emit('villa', { villaId, status: 'RUNNING', concurrency: job.concurrency });

  let productCompleted = false;
  let retryAfterMs = 0;
  try {
    while (true) { // Ende: Stopp, Autonomie-Aus, Fehler/Budget oder echtes Produkt-Abnahmegate
      if (job.stop) break;
      if (!job.runToCompletion && now() - runStart > budgetMs) break; // Nur normale Läufe rotieren zeitbasiert

      const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
      if (!villa || villa.autonomy === 0) break;

      const tasks = openTasks(villaId);

      // Alles erledigt: der Deep Agent prueft und ergaenzt fehlende Aufgaben.
      // Die Runden sind gedeckelt und liegen in der Villa, damit ein Neustart
      // nicht wieder bei null beginnt und der Lauf garantiert endet.
      if (!tasks.length) {
        // Fehlgeschlagenes zuerst automatisch wieder aufnehmen (max. 3 Versuche).
        const requeued = requeueFailed(villaId);
        if (requeued > 0) {
          emit('progress', { villaId, processed: job.processed, requeued, note: 'Fehlgeschlagene Aufgabe(n) wieder aufgenommen' });
          continue;
        }
        const rounds = Number(villa.auto_rounds || 0);
        if (job.runToCompletion) {
          if (sourceRoot(villaId)) {
            const verification = await verifyProject(villaId);
            emit('progress', { villaId, processed: job.processed, finalVerification: verification?.skipped ? 'skipped' : (verification?.ok ? 'passed' : 'failed') });
            if (verification && verification.ok === false) continue;
          }
          const { maturity } = await import('./product.mjs');
          const finalProduct = maturity(villaId);
          if (finalProduct.verified && finalProduct.score >= 100) {
            productCompleted = true;
            db.prepare("UPDATE villas SET autonomy=0,status='COMPLETED',updated_at=? WHERE id=?").run(now(), villaId);
            db.prepare('DELETE FROM control_settings WHERE key=?').run(`villaFinishBeforeRotation:${villaId}`);
            emit('villa', { villaId, status: 'COMPLETED', qualityScore: finalProduct.score, delivery: finalProduct.readiness?.status || 'verified' });
            break;
          }
        }
        if (adaptive && rounds < maxRounds) {
          db.prepare('UPDATE villas SET auto_rounds = auto_rounds + 1, updated_at = ? WHERE id = ?').run(now(), villaId);
          // Rueckmeldung aus dem echten Projekt: Build-/Testlauf pro Runde,
          // Fehler werden sofort als Aufgabe behandelt (schnelle Selbstheilung).
          if (sourceRoot(villaId)) {
            const v = await verifyProject(villaId);
            emit('progress', { villaId, processed: job.processed, verification: v?.skipped ? 'skipped' : (v?.ok ? 'passed' : 'failed'), round: rounds + 1, maxRounds });
            if (v && v.ok === false) continue; // Fix-Aufgabe wurde angelegt, Pool erneut pruefen
          }
          const added = await reviewAndExpand(villaId);
          emit('progress', { villaId, processed: job.processed, open: 0, added, round: rounds + 1, maxRounds });
          if (added > 0) continue;
        }
        // 24/7: kein Stillstand. Ohne offene Aufgaben kommt sofort die
        // naechste Welle (Phasen-Pflichten, sonst Verbesserungswelle).
        const { developCycle } = await import('./product.mjs');
        // Im Abschlusslauf keine endlosen Verbesserungswellen anhaengen:
        // nur fehlende Pflicht- und Verifikationsaufgaben nachziehen.
        const wave = developCycle(villaId, { includeImprovementWave: !job.runToCompletion });
        if (wave.added > 0) {
          emit('progress', { villaId, processed: job.processed, wave: wave.added, maturity: wave.maturity.score, phase: wave.maturity.currentPhase, note: 'Naechste Welle' });
          continue;
        }
        break;
      }

      // Rollenpassende Aufgaben zuerst, damit Agenten nicht fachfremd arbeiten.
      tasks.sort((a, b) => (guessRole(a) === guessRole(b) ? a.priority - b.priority : 0));

      const batch = tasks.slice(0, job.concurrency);
      for (const task of batch) {
        const startedAt = now();
        db.prepare("UPDATE tasks SET status = 'RUNNING', started_at = ?, duration_ms = 0, updated_at = ? WHERE id = ?").run(startedAt, startedAt, task.id);
      }

      const executeLocally = (task) => executeTaskOnce(villaId, task).catch((e) => {
        // Eine Ausnahme in EINER Aufgabe beendet nicht den ganzen Lauf:
        // Aufgabe wird FAILED markiert (Befund im Ergebnis) und automatisch
        // ueber requeueFailed bis zu 3x neu aufgenommen.
        if(e.code==='LLM_UNAVAILABLE') {
          retryAfterMs = Math.max(retryAfterMs, Number(e.retryAfter) * 1000 || 15_000);
          job.stop=true;
          db.prepare("UPDATE tasks SET status='PENDING',result=?,updated_at=? WHERE id=?").run('LLM_UNAVAILABLE: Warte auf echte Modellverbindung.',now(),task.id);
          emit('task',{villaId,taskId:task.id,status:'PENDING',code:e.code});
          return;
        }
        const msg = String(e?.message || e).slice(0, 300);
        // Stack in den Hub-Log: Damit ist der Fundort interner Fehler exakt
        // rueckverfolgbar und die Selbstheilung kann die Ursache beheben.
        console.error(new Date().toISOString(), '[villaforge] INTERNER FEHLER Task', task.id, JSON.stringify(task.title), '\n' + (e?.stack || String(e)));
        db.prepare("UPDATE tasks SET status = 'FAILED', result = ?, updated_at = ? WHERE id = ?")
          .run('Interner Fehler: ' + msg, now(), task.id);
        emit('task', { villaId, taskId: task.id, agentId: task.agent_id || null, status: 'FAILED', error: msg });
      });
      const runtimeUrl=String(process.env.VF_AGENT_RUNTIME_URL||'').trim().replace(/\/+$/,'');
      const runtimeToken=String(process.env.VF_AGENT_RUNTIME_TOKEN||'').trim();
      if(runtimeUrl&&runtimeToken){
        const dispatched=await Promise.all(batch.map(async task=>{
          const requestKey=`hub:${villaId}:${task.id}:${task.retry_count||0}:${runStart}`;
          try{
            const response=await fetch(`${runtimeUrl}/tasks`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${runtimeToken}`,'idempotency-key':requestKey},body:JSON.stringify({title:task.title,input:{hubTaskId:Number(task.id),villaId:Number(villaId)}}),signal:AbortSignal.timeout(5000)});
            if(!response.ok)throw new Error(`Runtime HTTP ${response.status}`);
            return {task,remote:true};
          }catch(error){console.warn('[villaforge] Redis task mesh fallback',Number(task.id),String(error?.message||error).slice(0,160));return {task,remote:false};}
        }));
        await Promise.all(dispatched.filter(x=>!x.remote).map(x=>executeLocally(x.task)));
        const remote=dispatched.filter(x=>x.remote);
        const waitLimit=Math.max(5000,Math.min(Number(process.env.VF_AGENT_RUNTIME_WAIT_MS)||60000,300000));
        const waitStarted=Date.now();
        while(remote.length&&!job.stop){
          const activeTasks=remote.filter(({task})=>db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id)?.status==='RUNNING');
          if(!activeTasks.length)break;
          if(Date.now()-waitStarted>=waitLimit){
            // If the remote worker is unavailable after accepting dispatch,
            // local execution uses the same in-process task lock. A late Redis
            // delivery will observe DONE or join the already-running promise.
            await Promise.all(activeTasks.map(({task})=>executeLocally(task)));
            break;
          }
          await new Promise(resolve=>setTimeout(resolve,250));
        }
      } else await Promise.all(batch.map(executeLocally));
      if(job.stop)break;
      job.processed += batch.length;
      if (job.processed >= maxTasks) job.processed = 0; // rollierendes Fenster im Dauerbetrieb
      emit('progress', { villaId, processed: job.processed, open: openTasks(villaId).length });

      // Fail-Fast-Verifikation (OpenHands-Muster): enthaelt die Batch echte Code-
      // Arbeit, laeuft sofort ein Build-/Testlauf statt erst am Rundenende.
      // Fehler landen als Prio-1-Aufgabe im selben Lauf (Selbstheilung), statt
      // dass fehlerhafter Code als 'erledigt' liegen bleibt. Gedrosselt auf
      // hoechstens alle 3 Minuten, damit die 4 VM-Kerne nicht astaephyxieren.
      const hadCode = batch.some((t) => ['CODER', 'TESTER', 'ARCHITECT'].includes(guessRole(t)));
      const lastVerify = verifyThrottle.get(villaId) || 0;
      if (hadCode && sourceRoot(villaId) && now() - lastVerify > 180_000) {
        verifyThrottle.set(villaId, now());
        const fast = await verifyProject(villaId);
        emit('progress', { villaId, processed: job.processed, fastVerification: fast?.skipped ? 'skipped' : (fast?.ok ? 'passed' : 'failed') });
        if (fast && fast.ok === false) continue; // Fix-Aufgabe liegt an -> Pool neu laden
      }
      // Sanftes Tempo, wenn ein Durchlauf nichts Fertiges brachte (Routen
      // gedrosselt/ohne Key): 60 Sekunden Pause statt endloses Haemmern.
      const freshDone = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'DONE' AND updated_at >= ?").get(villaId, batchStart).c;
      if (freshDone === 0) {
        // Stopp waehrend eines gedrosselten Leerlaufs nicht erst nach einer
        // vollen Minute bemerken.
        const waitUntil = Date.now() + 60_000;
        while (!job.stop && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, Math.min(250, waitUntil - Date.now())));
      }
    }

    // Der Lauf endet nur durch Stopp, Autonomie-Aus oder Fehler. Ein
    // 'COMPLETED' gibt es im 24/7-Betrieb nicht - die Projektpruefung
    // laeuft regelmaessig in den adaptiven Runden innerhalb der Schleife.
    const status = productCompleted ? 'COMPLETED' : retryAfterMs ? 'WAITING_FOR_MODEL' : 'PAUSED';

    // History-Rotation am Lauf-Ende: audit/memories je Villa auf Fenster
    // kuerzen (wichtige Erinnerungen ueberleben). Haelt die DB dauerhaft
    // schnell, statt mit jedem Lauf zu wachsen.
    const pruned = pruneHistory(villaId);

    db.prepare('UPDATE villas SET status = ?, autonomy = CASE WHEN ? = 1 THEN 0 ELSE autonomy END, updated_at = ? WHERE id = ?').run(status, productCompleted ? 1 : 0, now(), villaId);
    emit('villa', { villaId, status, processed: job.processed, pruned, ...(retryAfterMs ? { retryAfterMs } : {}) });
    // v1.42.0 — APK-Bereitstellung (Nutzerdirektive 2026-10-18): Hat die Villa
    // alle Aufgaben erledigt, stoesst der Hub die APK-Baustrasse einmalig an -
    // die fertige APK landet als GitHub-Release und ist abrufbar.
    maybeDeliverApk(villaId).catch((e) => console.error('[villaforge] APK-Delivery Villa ' + villaId + ' fehlgeschlagen:', String(e?.message || e)));
  } catch (err) {
    console.error('[villaforge] Villa ' + villaId + ' Lauf abgestuerzt:', err);
    if (err.code === 'LLM_UNAVAILABLE') retryAfterMs = Math.max(retryAfterMs, Number(err.retryAfter) * 1000 || 15_000);
    const status = err.code === 'LLM_UNAVAILABLE' ? 'WAITING_FOR_MODEL' : 'FAILED';
    db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), villaId);
    emit('villa', { villaId, status, code:err.code,error: String(err.message || err), ...(retryAfterMs ? { retryAfterMs } : {}) });
  } finally {
    running.delete(villaId);
  }
  return retryAfterMs ? { retryAfterMs } : { status: productCompleted ? 'COMPLETED' : 'PAUSED' };
}

/**
 * Der Deep Agent prueft den Gesamtstand und ergaenzt fehlende Aufgaben.
 * Das macht die Villa selbstheilend, ohne in eine Endlosschleife zu laufen.
 */
/**
 * Fehlgeschlagene Aufgaben automatisch zurueckstellen: bis zu 5 je Zyklus,
 * hoechstens 3 Versuche je Aufgabe. Danach bleibt sie FAILED (sichtbar im
 * Audit) und blockiert den Dauerbetrieb nicht.
 */
function requeueFailed(villaId) {
  const rows = db.prepare("SELECT id FROM tasks WHERE villa_id = ? AND status = 'FAILED' AND retry_count < 3 ORDER BY updated_at ASC LIMIT 5").all(villaId);
  for (const t of rows) {
    db.prepare("UPDATE tasks SET status = 'PENDING', retry_count = retry_count + 1, updated_at = ? WHERE id = ?").run(now(), t.id);
  }
  return rows.length;
}

async function reviewAndExpand(villaId) {
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
  const root = db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(villaId);
  if (!villa || !root) return 0;

  // Produkt-Pipeline zuerst: fehlende Pflichten der aktuellen Phase entstehen
  // deterministisch (kein LLM-Aufruf noetig) - die Villa laeuft Richtung Marktreife.
  const { ensurePhaseTasks } = await import('./product.mjs');
  const phaseAdded = ensurePhaseTasks(villaId);
  if (phaseAdded > 0) return phaseAdded;

  const done = db.prepare("SELECT title, result FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY id ASC LIMIT 40").all(villaId);
  const summary = done.map((t) => `- ${t.title}: ${String(t.result || '').slice(0, 160)}`).join('\n');

  const res = await runAgent(
    root,
    `Idee: ${villa.idea}\n\nProjekt-Kontext:\n${projectProfile(villaId, 1000)}\n\nBisher erledigte Aufgaben:\n${summary || '(keine)'}\n\n` +
      'Pruefe, ob die Idee damit vollstaendig und umsetzbar ist. Lege NUR fehlende, noch nicht erledigte Aufgaben mit task_create an (hoechstens 5, jeweils mit Akzeptanzkriterium). ' +
      'Wiederhole keine bereits erledigte Aufgabe. Wenn nichts fehlt, antworte mit {"final":"Fertig"} ohne Werkzeugaufruf.',
    { maxSteps: 6, villaId }
  );

  const created = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'PENDING'").get(villaId).c;
  if (created > 0 && res.answer) {
    db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(villaId, root.id, 'villa', 'DECISION', 'Abschlusspruefung', String(res.answer).slice(0, 1500), 8, now());
  }
  return created;
}


/** Echter-Code-Qualitaetstor (v1.37.0): Code-Aufgaben am echten Projekt
 *  muessen den Build/Test-Tor (npm test) passieren, bevor sie als DONE
 *  gelten. Nichtbestehen schiebt die Aufgabe mit [Q-GATE]-Marker genau
 *  einmal zurueck ins Backlog. Ohne Projekt oder Test-Script wird der Tor
 *  uebersprungen (keine False-Bounces). */
export async function runQualityGate(villaId, task, answer) {
  if (!packEnabled('qualitaetstor')) return { passed: true, annotated: answer, skipped: 'pack' };

  // v1.40.0: Das Tor bewertet auch Eigentwicklungen im Villa-Projektordner —
  // erledigte Aufgaben duerfen keine reinen Berichte mehr sein.
  const root = sourceRoot(villaId) || villaProjectDir(villaId);
  const EMPTY = 'Qualitaetstor: Der Projektordner ist leer — die Umsetzung muss als echte Dateien mit code_write in den Projektordner (z.B. src/, tests/, package.json, requirements.txt). Ein Bericht allein zaehlt nicht als Umsetzung.';
  const countFiles = (dir) => {
    try {
      return readdirSync(dir, { recursive: true }).filter((f) => {
        const parts = String(f).split('/');
        return !parts.some((p) => p.startsWith('.') || p === 'node_modules');
      }).length;
    } catch { return 0; }
  };
  if (!existsSync(root) || countFiles(root) === 0) return { passed: false, output: EMPTY, annotated: answer };
  let hasPkg = false; let hasTest = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    hasPkg = true; hasTest = !!pkg?.scripts?.test;
  } catch { /* kein npm-Projekt */ }
  if (hasPkg && hasTest) {
    const gate = await runTool({ villaId, agentId: 0, role: 'INTEGRATOR' }, 'project_run', { binary: 'npm', args: ['test', '--silent'], timeoutMs: 180000 });
    const passed = /^Exit 0/.test(String(gate));
    return { passed, output: String(gate), annotated: passed ? `${answer}\n\n[Qualitaetstor: npm test gruen.]` : answer };
  }
  if (hasPkg && !hasTest) return { passed:false,annotated:answer,output:'Tests fehlen: npm test muss echte Fehlerfälle prüfen.' };
  // Python-Projekte: Syntax-Tor (py_compile) ueber alle .py-Dateien
  let pys = [];
  try {
    pys = readdirSync(root, { recursive: true }).map(String)
      .filter((f) => f.endsWith('.py') && !f.split('/').some((p) => p.startsWith('.') || p === 'node_modules'))
      .slice(0, 40);
  } catch { pys = []; }
  if (pys.length) {
    let out = ''; let passed = true;
    try {
      execFileSync('python3',['-m','py_compile',...pys],{cwd:root,stdio:'pipe',timeout:120000});
    } catch (e) {
      passed = false;
      out = String(e?.stdout || '') + String(e?.stderr || '');
    }
    return { passed, output: `Exit ${passed ? 0 : 1}:\n${out || '(keine Ausgabe)'}`, annotated: passed ? `${answer}\n\n[Qualitaetstor: py_compile gruen.]` : answer };
  }
  return { passed:false,annotated:answer,output:'Keine ausführbare Testprüfung gefunden.' };
}


/** v1.40.0 — Autonomes Produkt-Repo: Der fertige Projektstand einer Villa
 *  wird in ein passendes GitHub-Repository gepusht (wird bei Bedarf angelegt).
 *  Token: Hub-Secret GITHUB_TOKEN. */
export async function publishToGitHub() {
  return {
    ok: false,
    error: 'Automatic publishing is disabled until a private branch and reviewed pull-request flow is implemented.'
  };
}

/** Selbst-Lern-Loop (v1.38.0): Fehlschlaege und Tor-Risse werden als
 *  LESSON-Erinnerung (Wichtigkeit 7) fuers ganze Team verewigt. */
export function recordLesson(villaId, agentId, title, content) {
  db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, agentId, 'villa', 'LESSON', String(title).slice(0, 200), String(content).slice(0, 1500), 7, now());
}

export async function executeTask(villaId, task, executionOptions = {}) {
  const role = guessRole(task);
  // Bevorzugt einen freien Agenten der passenden Rolle, damit parallele
  // Aufgaben nicht denselben Agenten doppelt belegen.
  const agent =
    (task.agent_id ? db.prepare('SELECT * FROM agents WHERE id = ? AND villa_id = ?').get(task.agent_id,villaId) : null) ||
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
  const profile = projectProfile(villaId);
  const recovery = recoverCheckpoint(task.id,agent.id);
  const recoveryHint = recovery && recovery.state?.status !== 'completed'
    ? `\nWIEDERAUFNAHME: Checkpoint ${recovery.checkpointId}, Schritt ${recovery.state.step || recovery.sequence}. Prüfe zuerst den vorhandenen Projektzustand und setze bei den noch fehlenden Abnahmekriterien fort; wiederhole bereits ausgeführte Änderungen nicht blind.`
    : '';
  const recent = db.prepare(
    "SELECT title, result FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY id DESC LIMIT 4"
  ).all(villaId).map((t) => `- ${t.title}: ${String(t.result || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
  const codeRole = ['CODER', 'REVIEWER', 'TESTER', 'ARCHITECT', 'INTEGRATOR'].includes(role);
  const prompt = [
    `Villa-Idee: ${idea}`,
    '',
    'Projekt-Kontext (richtet deine Arbeit an diesem Projekt aus):',
    profile,
    '',
    recent ? `Kuerzlich erledigt (baue darauf auf, wiederhole nichts):\n${recent}\n` : '',
    `Deine Teilaufgabe: ${task.title}`,
    `Beschreibung: ${task.description}`,
    recoveryHint,
    '',
    codeRole
      ? 'Liefere ECHTEN CODE: Schreibe die Umsetzung als echte Dateien mit code_write in den Projektordner (z.B. src/main.py, tests/, package.json, requirements.txt). Reine Berichte ohne neue Dateien reissen das Qualitaetstor. Nutze project_read/project_search/project_run zum Pruefen und sichere Ergebnisnotizen zusaetzlich mit artifact_write/artifact_patch.'
      : 'Pruefe zuerst mit memory_search verwertbare Vorarbeiten, dann erledige die Aufgabe vollstaendig.',
    'Speichere das Ergebnis mit memory_write (Titel = Aufgabe, Inhalt = Kernresultat).',
    'Schliesse mit {"final":"..."} ab. Das Ergebnis muss ohne Nachfragen verwendbar sein.'
  ].filter(Boolean).join('\n');

  // Rollenbasierte Budgets: Code-Rollen brauchen mehr Schritte und Tokens,
  // einfache Rollen weniger - das beschleunigt den Lauf spuerbar.
  const maxSteps = ['CODER', 'ARCHITECT', 'INTEGRATOR'].includes(role) ? 12 : codeRole ? 8 : 6;
  const maxTokens = ['CODER', 'ARCHITECT', 'DOCUMENTER', 'INTEGRATOR'].includes(role) ? 3500 : 1400;
  let res;
  try { res = await runAgent(agent,prompt,{maxSteps,villaId,maxTokens,taskId:task.id,
    ...(executionOptions.promptHint ? {promptHint:executionOptions.promptHint} : {}),
    ...(executionOptions.fallbackModel ? {preferredModel:executionOptions.fallbackModel} : {})}); }
  catch(error){
    saveCheckpoint({taskId:task.id,agentId:agent.id,state:{status:'interrupted',step:recoverCheckpoint(task.id,agent.id)?.state?.step||0,errorCode:String(error.code||'AGENT_ERROR').slice(0,80)}});
    db.prepare("UPDATE agents SET status='IDLE',last_active_at=? WHERE id=?").run(now(),agent.id);
    db.prepare("UPDATE tasks SET status='PENDING',result=?,updated_at=? WHERE id=?").run(error.code==='LLM_UNAVAILABLE'?'LLM_UNAVAILABLE: Warte auf echte Modellverbindung.':'Agentenlauf unterbrochen.',now(),task.id);
    if(error.code==='LLM_UNAVAILABLE')db.prepare("UPDATE villas SET status='PAUSED',updated_at=? WHERE id=?").run(now(),villaId);
    throw error;
  }

  if(res.code==='LLM_UNAVAILABLE'||res.offline){
    saveCheckpoint({taskId:task.id,agentId:agent.id,state:{status:'waiting_for_model',step:recoverCheckpoint(task.id,agent.id)?.state?.step||0,errorCode:'LLM_UNAVAILABLE'}});
    db.prepare("UPDATE agents SET status='IDLE',last_active_at=? WHERE id=?").run(now(),agent.id);
    db.prepare("UPDATE tasks SET status='PENDING',result=?,updated_at=? WHERE id=?").run('LLM_UNAVAILABLE: Warte auf echte Modellverbindung.',now(),task.id);
    throw Object.assign(new Error('Kein echtes Modell erreichbar; Aufgabe bleibt offen.'),{code:'LLM_UNAVAILABLE',statusCode:503});
  }
  let answer = res.answer || res.error || 'Kein Ergebnis.';

  // Qualitaetstor: Code-Aufgaben muessen den echten Test-Tor passieren.
  if (!res.error && codeRole) {
    const gate = await runQualityGate(villaId, task, answer);
    if (!gate.passed) {
      saveCheckpoint({taskId:task.id,agentId:agent.id,state:{status:'quality_gate_failed',step:recoverCheckpoint(task.id,agent.id)?.state?.step||0,errorCode:'QUALITY_GATE'}});
      db.prepare('UPDATE tasks SET status = ?, result = ?, priority = MAX(1,priority - 1), retry_count=COALESCE(retry_count,0)+1, updated_at = ? WHERE id = ?')
        .run(Number(task.retry_count||0)>=2?'FAILED':'PENDING', `Qualitaetstor nicht bestanden, Retry angefordert:\n${gate.output.slice(0, 1200)}\n\n${answer}`.slice(0, 4000), now(), task.id);
      db.prepare("UPDATE tasks SET title = title || ' [Q-GATE]' WHERE id = ? AND title NOT LIKE '%[Q-GATE]%'").run(task.id);
      db.prepare('UPDATE agents SET status = ?, last_active_at = ? WHERE id = ?').run('IDLE', now(), agent.id);
      // Selbst-Lern-Loop: Der Tor-Riss wird als Lehre verewigt, damit kein
      // Team-Mitglied denselben Fehler zweimal macht.
      recordLesson(villaId, agent.id, `Lehre: ${task.title}`, `npm test scheiterte nach der Umsetzung — erst Build/Test-Tor gruen, dann abschliessen. Auszug:\n${String(gate.output).slice(0, 600)}`);
      emit('task', { villaId, taskId: task.id, agentId: agent.id, status: 'GATE_RETRY', title: `${task.title} [Q-GATE]` });
      return;
    }
    answer = gate.annotated;
    // Veröffentlichungen nur über einen geprüften Pull Request.
  }

  const completedAt = now();
  db.prepare('UPDATE tasks SET status = ?, result = ?, duration_ms = CASE WHEN started_at > 0 THEN MAX(0, ? - started_at) ELSE duration_ms END, updated_at = ? WHERE id = ?')
    .run(res.error ? 'FAILED' : 'DONE', answer.slice(0, 4000), completedAt, completedAt, task.id);
  saveCheckpoint({taskId:task.id,agentId:agent.id,state:{status:res.error?'failed':'completed',step:recoverCheckpoint(task.id,agent.id)?.state?.step||0,answerBytes:Buffer.byteLength(answer),...(res.error?{errorCode:'AGENT_ERROR'}:{})}});
  if (res.error) {
    recordLesson(villaId, agent.id, `Lehre: ${task.title}`, `Aufgabe schlug fehl. Ursache analysieren und beim naechsten Versuch zuerst beheben:\n${String(res.error).slice(0, 600)}`);
  }
  db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)').run(villaId, agent.id, 'assistant', answer.slice(0, 4000), now());
  db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, agent.id, 'villa', 'ARTIFACT', `Ergebnis: ${task.title}`, answer.slice(0, 2000), 6, now());
  db.prepare('UPDATE agents SET status = ?, last_active_at = ? WHERE id = ?').run('IDLE', now(), agent.id);

  emit('task', { villaId, taskId: task.id, agentId: agent.id, status: res.error ? 'FAILED' : 'DONE', title: task.title, answer: answer.slice(0, 500) });
}

/** Same-process idempotency guard shared by local scheduling and mesh callbacks. */
export function executeTaskOnce(villaId, task, executionOptions = {}) {
  const key=String(task?.id);
  const current=taskExecutions.get(key);
  if(current)return current;
  const execution=executeTask(villaId,task,executionOptions).finally(()=>taskExecutions.delete(key));
  taskExecutions.set(key,execution);
  return execution;
}

export function guessRole(task) {
  const assigned=String(task.role||String(task.description||'').match(/\bRolle:\s*([A-Z_]+)/i)?.[1]||'').toUpperCase();
  if(ROLES.includes(assigned))return assigned;
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
  if (/strategie|szenario|entscheidung|roadmap|priorisier/.test(t)) return 'STRATEGIST';
  if (/analyse|begr|ursache|zusammenhang|denk|argument/.test(t)) return 'REASONER';
  if (/verbind|synthes|querschnitt|abstimm|kompromiss/.test(t)) return 'SYNTHESIZER';
  if (/optimier|engpass|leistung|durchsatz|verbesser/.test(t)) return 'OPTIMIZER';
  if (/verifiz|pruef|beleg|fakten|nachweis/.test(t)) return 'VERIFIER';
  return 'WORKER';
}
