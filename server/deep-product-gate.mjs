/**
 * Produkt-Gate fuer Deep-Agent-Projekte (Nikos Auftrag 2026-11-02).
 *
 * Regel: Eine Villa entsteht ERST, wenn das Projekt ein belegtes Produkt
 * hervorgebracht hat. Bisher legte `POST /api/deep/projects/:id/develop`
 * sofort eine Villa an - die Idee wurde also zur Villa, ohne dass je etwas
 * Funktionsfaehiges existierte.
 *
 * Das Gate prueft vorhandene Beweise statt Absichten:
 * - Quellcode, Spezifikation, Abnahmekriterien, Tests, README mit Startbefehl
 * - einen aufgezeichneten Verifikationslauf (Build/Test/Nutzerfluss)
 * - keine hinterlegten Secrets
 *
 * "Unbekannt" ist nie "bestanden": fehlt ein Beleg, blockiert das Gate und
 * nennt den konkreten Grund. Reine Logik, kein Dateisystem in
 * evaluateProductGate -> testbar ohne Fixtures.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.dart', '.kt', '.java', '.go', '.rs', '.php', '.swift', '.rb', '.cs']);
const TEST_PATTERN = /\.(test|spec)\.(m?js|cjs|ts|tsx|jsx|py|dart|kt|java)$|(^|\/)(tests?|__tests__)\//i;
const SPEC_PATTERN = /(spec|brief|anforderung|konzept|produkt)/i;
const ACCEPTANCE_PATTERN = /(acceptance|abnahme|kriteri|definition-of-done|dod)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.gradle', 'vendor']);

const SECRET_PATTERNS = [
  { key: 'stripe_live', re: /\bsk_live_[A-Za-z0-9]{10,}/ },
  { key: 'stripe_restricted', re: /\brk_live_[A-Za-z0-9]{10,}/ },
  { key: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { key: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { key: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { key: 'private_key_block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { key: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
];

function entry(ok, label, evidence) {
  return { status: ok ? 'passed' : 'failed', label, evidence };
}

function unknown(label, hint) {
  return { status: 'unknown', label, evidence: hint };
}

/** Abnahmekriterien zaehlen: JSON-Liste oder Markdown-Checkboxen. */
export function countAcceptanceCriteria(content) {
  const text = String(content || '');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && Array.isArray(parsed.criteria)) return parsed.criteria.length;
    if (parsed && Array.isArray(parsed.acceptance)) return parsed.acceptance.length;
  } catch {
    /* kein JSON: Markdown pruefen */
  }
  const boxes = text.match(/^\s*[-*]\s*\[[ xX]\]\s+\S+/gm);
  return boxes ? boxes.length : 0;
}

/** Prueft beliebigen Text auf bekannte Schluesselmuster (fuer Artefakte ohne Dateibezug). */
export function findSecretInText(text) {
  const content = String(text || '');
  if (!content) return null;
  for (const { key, re } of SECRET_PATTERNS) {
    if (re.test(content)) return { file: '(artefakte)', kind: key };
  }
  return null;
}

function findSecret(files) {
  for (const file of files) {
    const content = file.content || '';
    if (!content) continue;
    for (const { key, re } of SECRET_PATTERNS) {
      if (re.test(content)) return { file: file.path, kind: key };
    }
  }
  return null;
}

/**
 * Bewertet ein Projekt anhand vorhandener Belege.
 * @param {{files?: Array<{path:string,content?:string,size?:number}>, verification?: object|null}} input
 */
export function evaluateProductGate({ files = [], verification = null } = {}) {
  const all = files.filter((f) => f && typeof f.path === 'string');
  const code = all.filter((f) => SOURCE_EXT.has(extension(f.path)) && !TEST_PATTERN.test(f.path));
  const tests = all.filter((f) => TEST_PATTERN.test(f.path));
  const spec = all.find((f) => SPEC_PATTERN.test(f.path) && String(f.content || '').trim().length >= 200);
  const acceptance = all.find((f) => ACCEPTANCE_PATTERN.test(f.path) && countAcceptanceCriteria(f.content) >= 2);
  const readme = all.find((f) => /(^|\/)readme(\.md|\.txt)?$/i.test(f.path));
  const startCommand = readme ? detectStartCommand(readme.content) : null;
  const secret = findSecret(all);

  const checks = {
    source: code.length >= 2
      ? entry(true, 'Quellcode vorhanden', code.slice(0, 5).map((f) => f.path))
      : entry(false, 'Quellcode vorhanden', code.map((f) => f.path)),
    spec: spec ? entry(true, 'Spezifikation beschrieben', spec.path) : entry(false, 'Spezifikation beschrieben', 'Datei mit Spec/Brief/Konzept und mindestens 200 Zeichen fehlt'),
    acceptance: acceptance
      ? entry(true, 'Abnahmekriterien pruefbar', `${countAcceptanceCriteria(acceptance.content)} Kriterien in ${acceptance.path}`)
      : entry(false, 'Abnahmekriterien pruefbar', 'mindestens 2 pruefbare Kriterien noetig (acceptance.json oder Checkboxen)'),
    tests: tests.length
      ? entry(true, 'Tests vorhanden', tests.slice(0, 5).map((f) => f.path))
      : entry(false, 'Tests vorhanden', 'keine Testdatei gefunden'),
    start: startCommand
      ? entry(true, 'Startbefehl dokumentiert', startCommand)
      : entry(false, 'Startbefehl dokumentiert', 'README ohne erkennbaren Startbefehl (npm start, node, python, flutter run, docker)'),
    secrets: secret
      ? entry(false, 'Keine Secrets im Projekt', `${secret.kind} in ${secret.file}`)
      : entry(true, 'Keine Secrets im Projekt', 'keine bekannten Schluesselmuster gefunden'),
    verification: verificationCheck(verification),
  };

  const blockers = Object.entries(checks)
    .filter(([, check]) => check.status !== 'passed')
    .map(([key, check]) => ({ key, label: check.label, detail: check.evidence }));
  return { ready: blockers.length === 0, checks, blockers };
}

function verificationCheck(verification) {
  if (!verification || typeof verification !== 'object') {
    return unknown('Verifikationslauf belegt', 'verification.json mit Build-, Test-, Smoke- und Download-Belegen fehlt');
  }
  const build = verification.build || {};
  const tests = verification.tests || {};
  const flow = verification.userFlow || {};
  const artifact = build.artifact || {};
  const smoke = flow.smoke || {};
  const download = flow.download || {};
  const sha256 = /^[a-f0-9]{64}$/i;
  const positiveBytes = (value) => Number.isSafeInteger(value) && value > 0;
  const safeRelativePath = (value) => typeof value === 'string' && value.length > 0
    && !value.startsWith('/') && !value.split(/[\\\\/]/).includes('..');
  const buildOk = build.status === 'passed' && safeRelativePath(artifact.path)
    && sha256.test(String(artifact.sha256 || '')) && positiveBytes(artifact.bytes);
  const testsOk = tests.status === 'passed' && Number.isSafeInteger(tests.passed) && tests.passed > 0
    && tests.failed === 0 && tests.skipped === 0 && typeof tests.runId === 'string' && tests.runId.trim().length > 0;
  const smokeOk = smoke.status === 'passed' && typeof smoke.runId === 'string' && smoke.runId.trim().length > 0;
  const downloadOk = download.status === 'passed' && typeof download.url === 'string'
    && /^\\/(?:api\\/|downloads\\/)|^https:\\/\\//i.test(download.url)
    && sha256.test(String(download.sha256 || '')) && positiveBytes(download.bytes);
  const details = {
    build: build.status || 'missing',
    buildArtifact: buildOk ? { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 } : 'missing-or-invalid',
    tests: tests.status || 'missing',
    testCounts: { passed: tests.passed ?? null, failed: tests.failed ?? null, skipped: tests.skipped ?? null, runId: tests.runId || null },
    smoke: smoke.status || 'missing',
    smokeRunId: smoke.runId || null,
    download: download.status || 'missing',
    downloadUrl: download.url || null,
    downloadBytes: download.bytes ?? null,
  };
  const missing = [];
  if (!buildOk) missing.push('Build-Artefakt mit relativem Pfad, SHA-256 und Bytegroesse');
  if (!testsOk) missing.push('Testlauf-ID mit mindestens einem bestandenen, null fehlgeschlagenen und null uebersprungenen Tests');
  if (!smokeOk) missing.push('bestandenener Smoke-/Nutzerfluss-Lauf mit Lauf-ID');
  if (!downloadOk) missing.push('erfolgreicher Download mit URL, SHA-256 und Bytegroesse');
  if (missing.length) {
    const failed = [build, tests, smoke, download].some((item) => item.status === 'failed');
    return {
      status: failed ? 'failed' : 'unknown',
      label: 'Verifikationslauf belegt',
      evidence: { missing, ...details },
    };
  }
  return entry(true, 'Verifikationslauf belegt', details);
}

function detectStartCommand(readmeContent) {
  const text = String(readmeContent || '');
  const match = text.match(/(npm (run )?(start|dev)|node [^\s`]+|python3? [^\s`]+|flutter run|docker compose up[^\n`]*|docker run[^\n`]*|\.\/start\.sh)/i);
  return match ? match[0].trim() : null;
}

function extension(path) {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? '' : path.slice(idx).toLowerCase();
}

/**
 * Liest die Belege eines Projektordners. Bewusst begrenzt: keine
 * node_modules/.git, max. 400 Dateien, max. 200 KB je Datei. Fehlt der
 * Ordner, ist das Gate nicht "bestanden", sondern unbewertbar (= blockiert).
 */
export function scanProjectEvidence(dir) {
  if (!dir || !existsSync(dir)) return { files: [], missing: true };
  const files = [];
  const walk = (current) => {
    let names;
    try {
      names = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      if (files.length >= 400) return;
      const full = join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        walk(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      const path = relative(dir, full);
      let content = '';
      if (size <= 200 * 1024) {
        try {
          content = readFileSync(full, 'utf8');
        } catch {
          content = '';
        }
      }
      files.push({ path, size, content });
    }
  };
  walk(dir);
  return { files, missing: false, dir };
}

/** Bequemer Einstieg fuer Endpunkte: Ordner scannen und Gate bewerten. */
export function productGateForProjectDir(dir, verification = null) {
  const scanned = scanProjectEvidence(dir);
  const result = evaluateProductGate({ files: scanned.files, verification: verification ?? readVerification(dir) });
  return scanned.missing ? { ...result, ready: false, blockers: [{ key: 'evidence', label: 'Projektbelege vorhanden', detail: 'Projektordner fehlt oder ist leer' }, ...result.blockers] } : result;
}

function readVerification(dir) {
  if (!dir) return null;
  const candidate = join(dir, 'verification.json');
  if (!existsSync(candidate)) return null;
  try {
    return JSON.parse(readFileSync(candidate, 'utf8'));
  } catch {
    return { build: { status: 'unknown' } };
  }
}
