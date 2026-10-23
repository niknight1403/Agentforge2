import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../server/version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'server/public');
const output = join(root, 'dist/web');
const html = readFileSync(join(source, 'index.html'), 'utf8');
const assets = [...html.matchAll(/\\b(?:href|src)=["'](\\/(?!\\/)[^"'?#]*)["']/g)].map((match) => decodeURIComponent(match[1]));
const missing = assets.filter((path) => !statSafe(join(source, path.slice(1))));
if (missing.length) throw new Error(`Web-Build: fehlende lokale Assets: ${missing.join(', ')}`);

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(source, output, { recursive: true });
const files = [];
function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else {
      const relative = path.slice(output.length + 1).split(sep).join('/');
      const content = readFileSync(path);
      files.push({ path: relative, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
}
walk(output);
writeFileSync(join(output, 'BUILD-METADATA.json'), `${JSON.stringify({ name: 'VillaForge Web', version: VERSION, entry: 'index.html', files }, null, 2)}\\n`);
console.log(`Web-Build ${VERSION}: ${files.length} Dateien nach dist/web; ${assets.length} lokale HTML-Assets geprueft.`);

function statSafe(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}
