/**
 * Materialisiert einen Blueprint als Dateibaum.
 *
 * Leitplanken:
 *  - Zielpfad muss relativ, ohne ".." und ohne Symlink-Ausbruch sein.
 *  - Ein vorhandenes, nicht leeres Zielverzeichnis wird nur mit `overwrite`
 *    beschrieben. Ein Bauauftrag darf nie ein fremdes Projekt ueberschreiben.
 *  - Jede Datei wird vor dem Schreiben auf Groesse und Pfad geprueft; der
 *    Rueckgabewert enthaelt Pfad, Groesse und SHA-256 je Datei.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { slugify } from './manifest.mjs';
import {
  HTTP_TEMPLATE, ROUTER_TEMPLATE, QUERY_TEMPLATE, VALIDATE_TEMPLATE, PASSWORD_TEMPLATE, JWT_TEMPLATE,
  MIDDLEWARE_TEMPLATE, DB_TEMPLATE, AUTH_ROUTES_TEMPLATE, APP_TEMPLATE, INDEX_TEMPLATE, MODELS_TEMPLATE,
} from './templates-runtime.mjs';
import {
  schemaFile, repositoryFile, routesFile, apiTestFile, packageJson, envExample, gitignore, readme,
  prismaSchema, migrationSql, prismaSeed, bcryptAdapterFile, projectManifestFile,
} from './templates-api.mjs';
import { clientFileMap } from './templates-client.mjs';

const MAX_FILES = 400;
const MAX_BYTES = 2 * 1024 * 1024;

const lowerFirst = value => value.charAt(0).toLowerCase() + value.slice(1);

/** Vollstaendige Dateiliste eines Projekts, noch ohne Schreiben. */
export function buildFileMap(manifest) {
  if (!manifest?.entities?.length) throw Object.assign(new Error('Der Blueprint enthaelt keine Domaene.'), { code: 'FULLSTACK_MANIFEST_EMPTY' });
  const files = new Map();
  files.set('server/lib/http.mjs', HTTP_TEMPLATE);
  files.set('server/lib/router.mjs', ROUTER_TEMPLATE);
  files.set('server/lib/query.mjs', QUERY_TEMPLATE);
  files.set('server/lib/validate.mjs', VALIDATE_TEMPLATE);
  files.set('server/lib/password.mjs', PASSWORD_TEMPLATE);
  files.set('server/lib/jwt.mjs', JWT_TEMPLATE);
  files.set('server/lib/bcrypt-adapter.mjs', bcryptAdapterFile());
  files.set('server/auth/middleware.mjs', MIDDLEWARE_TEMPLATE);
  files.set('server/db.mjs', DB_TEMPLATE);
  files.set('server/models.mjs', MODELS_TEMPLATE(Object.fromEntries(manifest.entities.map(entity => [entity.table, lowerFirst(entity.model)]))));
  files.set('server/routes/auth.routes.mjs', AUTH_ROUTES_TEMPLATE);

  for (const entity of manifest.entities) {
    files.set(`server/schemas/${entity.key}.schema.mjs`, schemaFile(entity));
    files.set(`server/repositories/${entity.key}.repository.mjs`, repositoryFile(entity));
    files.set(`server/routes/${entity.key}.routes.mjs`, routesFile(entity));
  }

  const routeImports = manifest.entities
    .map(entity => `import { register${entity.model}Routes } from './routes/${entity.key}.routes.mjs';`)
    .join('\n');
  const routeRegistrations = manifest.entities
    .map(entity => `  register${entity.model}Routes(router, { store, authenticate: auth.authenticate, requireRole: auth.requireRole });`)
    .join('\n');
  files.set('server/app.mjs', APP_TEMPLATE(routeImports, routeRegistrations));
  files.set('server/index.mjs', INDEX_TEMPLATE);
  files.set('server/tests/api.test.mjs', apiTestFile(manifest));

  files.set('package.json', packageJson(manifest));
  files.set('.env.example', envExample());
  files.set('.gitignore', gitignore());
  files.set('README.md', readme(manifest));
  files.set('project_manifest.json', projectManifestFile(manifest));
  files.set('prisma/schema.prisma', prismaSchema(manifest));
  files.set('prisma/seed.mjs', prismaSeed(manifest));
  files.set('prisma/migrations/0001_init/migration.sql', migrationSql(manifest));

  for (const [path, content] of clientFileMap(manifest)) files.set(path, content);

  if (files.size > MAX_FILES) throw Object.assign(new Error('Der Blueprint erzeugt zu viele Dateien.'), { code: 'FULLSTACK_TOO_MANY_FILES' });
  for (const [path, content] of files) {
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error(`Vorlage fuer ${path} ist leer.`), { code: 'FULLSTACK_TEMPLATE_EMPTY', path });
    if (Buffer.byteLength(content) > MAX_BYTES) throw Object.assign(new Error(`Vorlage fuer ${path} ist zu gross.`), { code: 'FULLSTACK_TEMPLATE_TOO_LARGE', path });
  }
  return files;
}

function assertSafeRelativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0')) throw Object.assign(new Error('Unsicherer Dateipfad im Blueprint.'), { code: 'FULLSTACK_PATH_UNSAFE' });
  const normalized = normalize(path);
  if (normalized.startsWith('..') || normalized.split(sep).includes('..')) throw Object.assign(new Error('Pfadausbruch im Blueprint verhindert.'), { code: 'FULLSTACK_PATH_UNSAFE' });
  return normalized;
}

/** Schreibt den Dateibaum und liefert den Nachweis (Pfad, Bytes, Digest). */
export function emitProject(manifest, targetDir, { overwrite = false, write = writeFileSync } = {}) {
  const root = resolve(String(targetDir || ''));
  if (!targetDir) throw Object.assign(new Error('Es wird ein Zielverzeichnis benoetigt.'), { code: 'FULLSTACK_TARGET_MISSING' });
  if (root === sep || /^[a-zA-Z]:\\?$/.test(root)) throw Object.assign(new Error('Das Wurzelverzeichnis ist kein gueltiges Ziel.'), { code: 'FULLSTACK_TARGET_UNSAFE' });
  if (existsSync(root)) {
    const stats = statSync(root);
    if (!stats.isDirectory()) throw Object.assign(new Error('Das Ziel ist keine Verzeichnis.'), { code: 'FULLSTACK_TARGET_NOT_DIRECTORY' });
    const entries = readdirSync(root).filter(entry => entry !== '.git');
    if (entries.length && !overwrite) throw Object.assign(new Error('Das Zielverzeichnis ist nicht leer. Ueberschreiben nur mit overwrite.'), { code: 'FULLSTACK_TARGET_NOT_EMPTY', entries: entries.slice(0, 10) });
    const real = realpathSync(root);
    if (real !== root) throw Object.assign(new Error('Symlink-Ziel wird nicht beschrieben.'), { code: 'FULLSTACK_TARGET_SYMLINK' });
  }

  const files = buildFileMap(manifest);
  const written = [];
  for (const [path, content] of files) {
    const relative = assertSafeRelativePath(path);
    const absolute = join(root, relative);
    if (!absolute.startsWith(root + sep)) throw Object.assign(new Error('Pfadausbruch im Blueprint verhindert.'), { code: 'FULLSTACK_PATH_UNSAFE' });
    mkdirSync(dirname(absolute), { recursive: true });
    write(absolute, content, 'utf8');
    written.push({ path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
  }
  const digest = createHash('sha256').update(written.map(file => `${file.path}:${file.sha256}`).join('\n')).digest('hex');
  return { root, slug: slugify(manifest.name), files: written, digest };
}

/** Nur die Pfade - praktisch fuer Pruefungen und Anzeige. */
export function plannedPaths(manifest) {
  return [...buildFileMap(manifest).keys()].sort();
}
