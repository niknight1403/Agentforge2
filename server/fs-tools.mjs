import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';

/**
 * Werkzeuge fuer den Zugriff auf den Quellcode einer bestehenden App.
 *
 * Sicherheitsmodell: Alle Pfad-Werkzeuge bleiben strikt innerhalb des
 * freigegebenen Projektordners. Absolute Pfade und ".." werden aufgeloest und
 * anschliessend gegen die Wurzel geprueft, sodass kein Ausbruch moeglich ist.
 * Die Ausfuehrung von Befehlen laeuft ueber eine Whitelist ohne Shell und
 * ausschliesslich mit Arbeitsverzeichnis innerhalb des Projekts.
 */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'out', '.gradle', '.idea',
  'venv', '.venv', '__pycache__', 'target', 'vendor', '.next', 'coverage'
]);

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml',
  '.kt', '.kts', '.java', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.cs', '.php',
  '.html', '.css', '.scss', '.sql', '.sh', '.xml', '.gradle', '.toml', '.env.example'
]);

/** Loest einen Pfad auf und erzwingt, dass er innerhalb der Wurzel liegt. */
export function safePath(root, candidate) {
  let rootAbs;
  try {
    rootAbs = realpathSync(resolve(root));
  } catch {
    return null; // Wurzel existiert nicht (oder ist ein kaputter Link).
  }
  const target = resolve(rootAbs, String(candidate || '.').replace(/^\/+/, ''));
  // Symlink-Haertung: ein Link IM Projekt, der nach aussen zeigt, wuerde
  // ohne Aufloesung als gueltiger relativer Pfad durchgehen. realpath
  // loest die komplette Kette auf; unvollstaendige Pfade werden geprueft,
  // sobald sie existieren.
  let realTarget = target;
  if (existsSync(target) || lstatExists(target)) {
    try {
      realTarget = realpathSync(target);
    } catch {
      return null; // haengender Link oder Link-Schleife (ELOOP): ablehnen.
    }
  }
  const rel = relative(rootAbs, realTarget);
  if (rel.startsWith('..') || (rel !== '' && resolve(rootAbs, rel) !== realTarget)) return null;
  return realTarget;
}

/** true, wenn der Pfad als Eintrag existiert — auch wenn er ein haengender Link ist. */
function lstatExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

export function isTextFile(path) {
  return TEXT_EXT.has(extname(path).toLowerCase());
}

function walk(dir, root, out, limit) {
  if (out.length >= limit) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), root, out, limit);
    } else if (entry.isFile()) {
      const full = join(dir, entry.name);
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      out.push({ path: relative(root, full), size });
    }
  }
}

/** Liefert den Dateibaum eines Projekts als Liste. */
export function projectTree(root, limit = 400) {
  const out = [];
  walk(resolve(root), resolve(root), out, limit);
  return out;
}

/** Fasst ein Projekt zusammen: Sprachen, Dateizahl, wichtige Dateien. */
export function projectSummary(root) {
  const abs = resolve(root);
  if (!existsSync(abs)) return { exists: false, files: 0, languages: [], highlights: [], bytes: 0 };
  const tree = projectTree(abs, 3000);
  const byExt = new Map();
  let bytes = 0;
  for (const f of tree) {
    const ext = extname(f.path).toLowerCase() || '(ohne)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
    bytes += f.size;
  }
  const languages = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([ext, count]) => ({ ext, count }));
  const highlights = tree
    .filter((f) => /(^|\/)(package\.json|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|README\.md|docker-compose\.ya?ml|Dockerfile)$/i.test(f.path))
    .map((f) => f.path)
    .slice(0, 25);
  return { exists: true, files: tree.length, languages, highlights, bytes, tree: tree.slice(0, 200) };
}

/** Sucht einen Text in allen Textdateien des Projekts. */
export function searchProject(root, query, limit = 60) {
  const abs = resolve(root);
  const needle = String(query || '').toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const f of projectTree(abs, 3000)) {
    if (hits.length >= limit) break;
    if (!isTextFile(f.path) || f.size > 400_000) continue;
    let text;
    try { text = readFileSync(join(abs, f.path), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

export function readProjectFile(root, relPath, maxBytes = 40_000) {
  const full = safePath(root, relPath);
  if (!full || !existsSync(full)) return { ok: false, error: 'Datei nicht gefunden' };
  if (!statSync(full).isFile()) return { ok: false, error: 'Kein regulaerer Datei-Pfad' };
  if (!isTextFile(full)) return { ok: false, error: 'Nur Textdateien koennen gelesen werden' };
  try {
    const text = readFileSync(full, 'utf8');
    return { ok: true, content: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/* ------------------------------------------------------------------ */
/* Ausfuehrung von Befehlen (Build, Tests)                             */
/* ------------------------------------------------------------------ */

/**
 * Erlaubte Programme mit erlaubten Unterbefehlen.
 *
 * Bewusst NICHT erlaubt sind Befehle, die Software nachladen (npm install,
 * npx, pip install). Damit kann ein Agent zwar bauen und testen, aber keine
 * fremden Pakete in das Projekt ziehen. Es gibt keine Shell und keine
 * Verkettung, Argumente werden nicht interpretiert.
 */
const COMMAND_POLICY = {
  npm: ['run', 'test', 'run-script', 'ls', 'list', 'why'],
  node: 'SCRIPT',
  python3: 'SCRIPT',
  python: 'SCRIPT',
  gradle: ['test', 'build', 'assemble', 'check', 'tasks']
};

// Inline-Auswertung umgeht jede Pfadpruefung und ist daher gesperrt.
const INLINE_EVAL = new Set(['-e', '--eval', '-c', '--command', '-p', '--print']);

// Argumente, die Netzwerk, Verkettung oder Ausbruch ermoeglichen.
const FORBIDDEN_ARGS = /(\|\||&&|;|`|\$\(|>|<|(^|\s)(--registry|--index-url|--extra-index-url|--global|-g|--force|--unsafe-perm|--ignore-scripts)(\s|$))|(https?:\/\/|git@)/i;

/**
 * Fuehrt einen Befehl im Projektordner aus. Der Aufruf dient dem Bauen und
 * Testen, nicht dem Nachladen fremder Software.
 */
export function runCommand(root, binary, args = [], timeoutMs = 120_000) {
  return new Promise((resolvePromise) => {
    const bin = String(binary || '').trim();
    if (!(bin in COMMAND_POLICY)) {
      return resolvePromise({ ok: false, error: `Befehl nicht erlaubt: ${bin}` });
    }
    const list = Array.isArray(args) ? args.map(String) : [];

    if (list.some((a) => INLINE_EVAL.has(a))) {
      return resolvePromise({ ok: false, error: 'Inline-Auswertung ist gesperrt. Nutze eine Skriptdatei im Projekt.' });
    }

    const policy = COMMAND_POLICY[bin];
    if (Array.isArray(policy)) {
      const sub = list.find((a) => !a.startsWith('-'));
      if (!sub || !policy.includes(sub)) {
        return resolvePromise({ ok: false, error: `Unterbefehl nicht erlaubt: ${sub || '(keiner)'}. Erlaubt: ${policy.join(', ')}` });
      }
    } else if (policy === 'SCRIPT') {
      // Nur eine Skriptdatei im Projekt, kein Inline-Code, keine Fremdquelle.
      const script = list.find((a) => !a.startsWith('-'));
      if (!script) return resolvePromise({ ok: false, error: 'Skriptpfad fehlt' });
      const full = safePath(root, script);
      if (!full || !existsSync(full)) {
        return resolvePromise({ ok: false, error: `Skript nicht im Projekt gefunden: ${script}` });
      }
    }
    if (list.some((a) => FORBIDDEN_ARGS.test(a))) {
      return resolvePromise({ ok: false, error: 'Argument nicht erlaubt (Netzwerk, Verkettung oder Ausbruch)' });
    }

    const cwd = resolve(root);
    if (!existsSync(cwd)) return resolvePromise({ ok: false, error: 'Projektordner fehlt' });

    execFile(bin, list, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV, CI: '1' }
    }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      const hint = err?.killed
        ? `Zeitlimit ueberschritten (${timeoutMs} ms)`
        : err ? String(err.message || err) : null;
      resolvePromise({
        ok: !err,
        code: err?.code ?? 0,
        output: out.slice(-6000),
        error: hint ? hint.slice(0, 400) : null
      });
    });
  });
}

export const ALLOWED = Object.entries(COMMAND_POLICY).map(([bin, subs]) => Array.isArray(subs) ? `${bin} (${subs.join('|')})` : `${bin} (Skriptdatei im Projekt)`);
