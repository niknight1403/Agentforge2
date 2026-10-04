/**
 * Secret-Scanner: durchsucht den Quelltext nach Mustern echter API-Keys und
 * schlaegt beim ersten Treffer an. Laeuft lokal als pre-commit-Check und in CI.
 *
 * Nutzung:  node scripts/check-secrets.mjs [Pfade...]
 * Ohne Argumente: alles im Repository ausser .git, Datenbanken, APKs, Bundles.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

// Muster echter Provider-Keys (Präfix plus ausreichende Laenge).
const PATTERNS = [
  { name: 'Groq-Key (gsk_…)', re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: 'OpenRouter-Key (sk-or-v1-…)', re: /sk-or-v1-[A-Za-z0-9-]{30,}/ },
  { name: 'OpenAI-Key (sk-…)', re: /sk-(proj-)?[A-Za-z0-9_-]{30,}/ },
  { name: 'Anthropic-Key (sk-ant-…)', re: /sk-ant-[A-Za-z0-9_-]{30,}/ },
  { name: 'Gemini-Key (AIza…)', re: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: 'GitHub-Token (ghp_…/github_pat_…)', re: /(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'Slack-Token (xox[baprs]-…)', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS-Key (AKIA…)', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Privater PEM-Block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle', 'data', 'incoming_files']);
const SKIP_EXT = new Set(['.db', '.db-wal', '.db-shm', '.apk', '.bundle', '.tar', '.xz', '.zip', '.png', '.jpg', '.jpeg', '.bin', '.jar']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else {
      if (SKIP_EXT.has(extname(entry.name))) continue;
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

let files = process.argv.slice(2);
if (!files.length) {
  const repoRoot = existsSync('.git') ? process.cwd() : join(process.cwd(), '..');
  files = walk(repoRoot);
}

let hits = 0;
for (const file of files) {
  let content;
  try {
    if (!statSync(file).isFile()) continue;
    content = readFileSync(file, 'utf8');
  } catch { continue; }
  for (const { name, re } of PATTERNS) {
    const m = content.match(re);
    if (m) {
      // Treffer-Position fuer eine schnelle Korrektur angeben.
      const line = content.slice(0, m.index).split('\n').length;
      console.error(`GEHEIMNIS GEFUNDEN: ${file}:${line} — ${name}`);
      hits++;
    }
  }
}

if (hits) {
  console.error(`\n${hits} Treffer. Keys gehoeren in GitHub Secrets bzw. VF_TOKEN/env, niemals in den Code.`);
  process.exit(1);
}
console.log('Secret-Scan: sauber.');
