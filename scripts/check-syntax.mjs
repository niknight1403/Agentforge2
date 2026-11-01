import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (['data', 'node_modules', 'artifacts'].includes(entry.name)) return [];
    return entry.isDirectory() ? files(path) : /\.m?js$/.test(path) ? [path] : [];
  });
}
const paths = [...files('server'), ...files('scripts')];
for (const path of paths) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(1); }
}
console.log(`${paths.length} JavaScript-Dateien: Syntax gültig`);
