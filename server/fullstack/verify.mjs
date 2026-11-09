/**
 * Express-Stufe: prueft einen erzeugten Dateibaum, bevor er als Produkt gilt.
 *
 * Zwei Ebenen:
 *  - Stufe 1 (immer, offline): Dateien vollstaendig, ESM-Syntax, JSX-Struktur,
 *    Vertraege (jede Domaene hat Schema/Repository/Routen/Test/Seite/Modell),
 *    keine Platzhalter, keine echten Schluessel, keine Host-Pfade.
 *  - Stufe 2 (nur mit Freigabe): `node --test` der generierten API in der
 *    Sandbox. In Entwicklung auf dem Host, im Produktivbetrieb nur in einem
 *    gepinnten Docker-Image (project-execution.mjs). Fehlt die Sandbox, gilt
 *    der Bau als nicht verifiziert - fail closed, kein stiller Host-Lauf.
 *
 * Kein Testfall hier fuehrt Fremdcode im Hub-Prozess aus.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { projectExecution } from '../project-execution.mjs';
import { executeInvocation } from '../project-process.mjs';
import { buildFileMap } from './emit.mjs';

const SECRET_PATTERNS = [
  { name: 'Groq-Key', re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: 'OpenRouter-Key', re: /sk-or-v1-[A-Za-z0-9-]{30,}/ },
  { name: 'OpenAI-Key', re: /sk-(proj-)?[A-Za-z0-9_-]{30,}/ },
  { name: 'Anthropic-Key', re: /sk-ant-[A-Za-z0-9_-]{30,}/ },
  { name: 'Gemini-Key', re: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: 'GitHub-Token', re: /(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'Slack-Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS-Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Privater PEM-Block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const PLACEHOLDER = /\b(TODO|FIXME|lorem ipsum|platzhalter|coming soon)\b/i;

/** ESM-Dateien: node --check prueft Syntax, ohne das Modul zu laden. */
async function syntaxCheck(root, relative) {
  try {
    await execFileAsync(process.execPath, ['--check', join(root, relative)], { encoding: 'utf8', timeout: 20000 });
    return null;
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim().split('\n').slice(0, 4).join(' ');
    return detail || 'Syntaxfehler';
  }
}

function stripLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * JSX ohne vollstaendigen Parser pruefen: Klammerbilanz und Tag-Bilanz.
 * Bewusst strukturell - der echte Vite-Build laeuft in Stufe 2.
 */
export function checkJsx(source, { requireExport = true } = {}) {
  const clean = stripLiterals(String(source || ''));
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const character of clean) {
    if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) {
      if (stack.pop() !== pairs[character]) return 'Klammern sind nicht ausbalanciert';
    }
  }
  if (stack.length) return 'Klammern sind nicht ausbalanciert';

  const opens = new Map();
  const closes = new Map();
  for (const match of clean.matchAll(/<([A-Za-z][A-Za-z0-9.]*)/g)) {
    const index = match.index || 0;
    if (clean.slice(Math.max(0, index - 1), index) === '/') continue;
    opens.set(match[1], (opens.get(match[1]) || 0) + 1);
  }
  for (const match of clean.matchAll(/<\/([A-Za-z][A-Za-z0-9.]*)/g)) {
    closes.set(match[1], (closes.get(match[1]) || 0) + 1);
  }
  // Selbstschliessende Tags sind ohne Parser nicht pro Tag sicher zuzuordnen
  // (Attribute enthalten selbst ">"). Deshalb zaehlen wir den Gesamtbedarf.
  const selfClosing = (clean.match(/\/>/g) || []).length;
  let deficit = 0;
  let worst = null;
  for (const [tag, count] of opens) {
    const missing = Math.max(0, count - (closes.get(tag) || 0));
    if (missing > 0) {
      deficit += missing;
      if (!worst || missing > worst.missing) worst = { tag, missing };
    }
  }
  if (deficit > selfClosing && worst) return `Tag <${worst.tag}> wird nicht geschlossen`;
  if (requireExport && !/export\s+(default\s+)?(function|const|class|\{)/.test(clean)) return 'Kein Export in der Komponente';
  return null;
}

function contractFindings(manifest, files) {
  const findings = [];
  const expect = (path, hint) => {
    if (!files.has(path)) findings.push({ check: 'contracts', code: 'CONTRACT_MISSING_FILE', file: path, detail: hint });
  };
  for (const entity of manifest.entities) {
    expect(`server/schemas/${entity.key}.schema.mjs`, 'Schema fehlt');
    expect(`server/repositories/${entity.key}.repository.mjs`, 'Repository fehlt');
    expect(`server/routes/${entity.key}.routes.mjs`, 'Routen fehlen');
    expect(`client/src/pages/${entity.clientPage}.jsx`, 'Seite fehlt');

    const routes = files.get(`server/routes/${entity.key}.routes.mjs`) || '';
    for (const guard of ['authenticate', "requireRole('Manager', 'Admin')", "requireRole('Admin')"]) {
      if (!routes.includes(guard)) findings.push({ check: 'contracts', code: 'ROUTE_GUARD_MISSING', file: `server/routes/${entity.key}.routes.mjs`, detail: `Waechter fehlt: ${guard}` });
    }
    for (const method of ['router.get', 'router.post', 'router.patch', 'router.delete']) {
      if (!routes.includes(method)) findings.push({ check: 'contracts', code: 'ROUTE_METHOD_MISSING', file: `server/routes/${entity.key}.routes.mjs`, detail: `${method} fehlt` });
    }
    const prisma = files.get('prisma/schema.prisma') || '';
    if (!new RegExp(`model ${entity.model} \\{`).test(prisma)) findings.push({ check: 'contracts', code: 'PRISMA_MODEL_MISSING', file: 'prisma/schema.prisma', detail: `Modell ${entity.model} fehlt` });
    const sql = files.get('prisma/migrations/0001_init/migration.sql') || '';
    if (!sql.includes(`CREATE TABLE "${entity.table}"`)) findings.push({ check: 'contracts', code: 'MIGRATION_TABLE_MISSING', file: 'prisma/migrations/0001_init/migration.sql', detail: `Tabelle ${entity.table} fehlt` });
    const test = files.get('server/tests/api.test.mjs') || '';
    if (!/[1-9]/.test(test)) findings.push({ check: 'contracts', code: 'TEST_MISSING', file: 'server/tests/api.test.mjs', detail: 'Kein Testfall erzeugt' });
  }
  if (!(files.get('server/auth/middleware.mjs') || '').includes('requireRole')) findings.push({ check: 'contracts', code: 'AUTH_MIDDLEWARE_MISSING', file: 'server/auth/middleware.mjs', detail: 'Rollenpruefung fehlt' });
  if (!(files.get('server/lib/jwt.mjs') || '').includes('timingSafeEqual')) findings.push({ check: 'contracts', code: 'TOKEN_CHECK_WEAK', file: 'server/lib/jwt.mjs', detail: 'Signatur wird nicht zeitkonstant verglichen' });
  if (!(files.get('server/lib/password.mjs') || '').includes('scrypt')) findings.push({ check: 'contracts', code: 'PASSWORD_HASH_MISSING', file: 'server/lib/password.mjs', detail: 'Kein Passworthashing' });
  return findings;
}

/** Prueft eine einzelne Datei auf verbotene Inhalte (Platzhalter, Schluessel, Hostpfade). */
export function scanContent(relative, content) {
  const findings = [];
  const placeholder = PLACEHOLDER.exec(content);
  if (placeholder) findings.push({ check: 'content', code: 'PLACEHOLDER_FOUND', file: relative, detail: `Platzhalter: ${placeholder[1]}` });
  let pemReported = false;
  for (const pattern of SECRET_PATTERNS) {
    if (!pattern.re.test(content)) continue;
    findings.push({ check: 'content', code: 'SECRET_PATTERN_FOUND', file: relative, detail: pattern.name });
    if (pattern.name === 'Privater PEM-Block') pemReported = true;
  }
  if (/(?:^|[^a-zA-Z0-9.])\/app\//.test(content)) findings.push({ check: 'content', code: 'HOST_PATH_FOUND', file: relative, detail: 'Absoluter Hub-Pfad im Projekt' });
  if (!pemReported && content.includes('-----BEGIN') && !content.includes('PUBLIC KEY')) findings.push({ check: 'content', code: 'PRIVATE_KEY_MATERIAL', file: relative, detail: 'Schluesselmaterial' });
  return findings;
}

function parseTestCounts(output) {
  // node --test schreibt je nach Version "# pass 8" (TAP) oder "ℹ pass 8".
  const pass = Number((/(?:#|\u2139)\s*pass\s+(\d+)/.exec(output) || [])[1] || 0);
  const fail = Number((/(?:#|\u2139)\s*fail\s+(\d+)/.exec(output) || [])[1] || 0);
  return { pass, fail };
}

/**
 * Fuehrt die generierten Tests aus. `mode` folgt project-execution.mjs
 * (host|docker|required). In Produktion ohne gepinntes Image bleibt der Bau
 * unverifiziert statt auf dem Host zu laufen.
 */
export async function runGeneratedTests(root, { mode, timeoutMs = 90_000, env = {} } = {}) {
  let invocation;
  try {
    invocation = projectExecution(root, process.execPath, ['--test', 'server/tests/api.test.mjs'], mode ? { mode } : undefined);
  } catch (error) {
    return { ok: false, ran: false, code: error.code || 'SANDBOX_REQUIRED', detail: error.message, pass: 0, fail: 0 };
  }
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', LANG: 'C.UTF-8', CI: '1', ...env };
  const result = await new Promise(resolve => {
    executeInvocation(invocation, { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: childEnv }, (error, stdout = '', stderr = '') => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const counts = parseTestCounts(output);
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'TEST_TIMEOUT' : 'TEST_RUN_FAILED';
    return { ok: false, ran: true, code, detail: output.slice(-2000) || result.error.message, ...counts };
  }
  return { ok: counts.fail === 0 && counts.pass > 0, ran: true, code: counts.pass > 0 && counts.fail === 0 ? null : 'TEST_FAILED', detail: output.slice(-4000), ...counts };
}

/**
 * Vollstaendige Pruefung. Liefert strukturierte Befunde, damit der Reviewer
 * gezielt reparieren kann, und eine Kurzfassung fuer Events.
 */
export async function verifyProject(root, manifest, options = {}) {
  const started = Date.now();
  const planned = buildFileMap(manifest);
  const failures = [];
  const syntaxCandidates = [];
  let files = 0;

  for (const [relative, expected] of planned) {
    const absolute = join(root, relative);
    if (!existsSync(absolute)) {
      failures.push({ check: 'files', code: 'MISSING_FILE', file: relative, detail: 'Datei fehlt' });
      continue;
    }
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size === 0) {
      failures.push({ check: 'files', code: 'EMPTY_FILE', file: relative, detail: 'Datei ist leer' });
      continue;
    }
    const content = readFileSync(absolute, 'utf8');
    if (content !== expected) {
      failures.push({ check: 'files', code: 'CONTENT_DRIFT', file: relative, detail: 'Inhalt weicht von der Vorlage ab' });
    }
    files += 1;
    failures.push(...scanContent(relative, content));
    if (/\.(mjs|js|cjs)$/.test(relative)) syntaxCandidates.push({ relative, content });
    else if (relative.endsWith('.jsx')) {
      const problem = checkJsx(content, { requireExport: !relative.endsWith('/main.jsx') });
      if (problem) failures.push({ check: 'syntax', code: 'JSX_STRUCTURE', file: relative, detail: problem });
    }
  }

  // Syntaxpruefung parallel: 40+ Einzelprozesse nacheinander waeren der
  // teuerste Teil jedes Baus. Fehler werden je Datei gemeldet, nicht global.
  const syntaxResults = await Promise.all(syntaxCandidates.map(async candidate => ({ file: candidate.relative, problem: await syntaxCheck(root, candidate.relative) })));
  for (const outcome of syntaxResults) {
    if (outcome.problem) failures.push({ check: 'syntax', code: 'SYNTAX_ERROR', file: outcome.file, detail: outcome.problem });
  }

  failures.push(...contractFindings(manifest, planned));

  // Stufe 2: nur wenn ausdruecklich erlaubt (Tests/Entwicklung) oder wenn eine
  // Sandbox vorhanden ist. VF_FULLSTACK_RUNTIME=0 ueberspringt sie bewusst.
  const runtimeEnabled = options.runtime !== false && process.env.VF_FULLSTACK_RUNTIME !== '0';
  let tests = { ok: true, ran: false, pass: 0, fail: 0, code: null, detail: 'Laufzeitpruefung uebersprungen' };
  const structurallyBlocked = failures.some(failure => ['files', 'syntax', 'content'].includes(failure.check));
  if (runtimeEnabled && !structurallyBlocked) {
    tests = await runGeneratedTests(root, { mode: options.sandboxMode, timeoutMs: options.timeoutMs, env: options.env });
    if (tests.ran && !tests.ok) {
      failures.push({ check: 'runtime', code: tests.code, file: 'server/tests/api.test.mjs', detail: tests.detail });
    } else if (!tests.ran) {
      failures.push({ check: 'runtime', code: tests.code, file: null, detail: tests.detail });
    }
  }

  const byCheck = {};
  for (const failure of failures) byCheck[failure.check] = (byCheck[failure.check] || 0) + 1;

  return {
    ok: failures.length === 0,
    root,
    files,
    planned: planned.size,
    failures,
    byCheck,
    tests: { ran: tests.ran, pass: tests.pass || 0, fail: tests.fail || 0 },
    durationMs: Date.now() - started,
  };
}

/** Kurzfassung fuer Events und Checkpoints: keine Dateiinhalte, keine Pfade in Masse. */
export function summarizeVerification(result) {
  return {
    ok: result.ok === true,
    files: result.files,
    planned: result.planned,
    failures: result.failures.length,
    testsPassed: result.tests.pass,
    testsFailed: result.tests.fail,
    checks: Object.keys(result.byCheck || {}).sort(),
    durationMs: result.durationMs,
  };
}
