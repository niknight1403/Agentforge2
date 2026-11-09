/**
 * Reviewer-Stufe: uebersetzt Befunde in konkrete, begrenzte Reparaturen.
 *
 * Repariert wird ausschliesslich durch Neuschreiben der betroffenen Datei aus
 * der Vorlage (diff-basiert nachvollziehbar). Es gibt keine "kreative" Heilung:
 * ein Fehler, der nicht aus dem Blueprint stammt, wird eskaliert statt geraten.
 * Damit bleibt der Bau reproduzierbar und der Reviewer kann nichts einschmuggeln.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFileMap } from './emit.mjs';

/** Grobe, aber ehrliche Diff-Zusammenfassung: Zeilenzahlen plus erste Aenderungen. */
export function summarizeDiff(before, after) {
  const beforeLines = String(before || '').split('\n');
  const afterLines = String(after || '').split('\n');
  const removed = [];
  const added = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) removed.push(index + 1);
    if (afterLines[index] !== undefined) added.push(index + 1);
  }
  return {
    removedLines: removed.length,
    addedLines: added.length,
    firstRemoved: removed.slice(0, 5),
    firstAdded: added.slice(0, 5),
    beforeBytes: Buffer.byteLength(String(before || '')),
    afterBytes: Buffer.byteLength(String(after || '')),
  };
}

const KNOWN_TEMPLATE_FILES = new Set([
  'server/lib/http.mjs', 'server/lib/router.mjs', 'server/lib/query.mjs', 'server/lib/validate.mjs',
  'server/lib/password.mjs', 'server/lib/jwt.mjs', 'server/lib/bcrypt-adapter.mjs',
  'server/auth/middleware.mjs', 'server/db.mjs', 'server/models.mjs',
  'server/routes/auth.routes.mjs', 'server/app.mjs', 'server/index.mjs', 'server/tests/api.test.mjs',
  'package.json', '.env.example', '.gitignore', 'README.md', 'project_manifest.json',
  'prisma/schema.prisma', 'prisma/seed.mjs', 'prisma/migrations/0001_init/migration.sql',
]);

function templateFor(files, path) {
  if (files.has(path)) return files.get(path);
  if (KNOWN_TEMPLATE_FILES.has(path)) return files.get(path) || null;
  return null;
}

/** Welche Datei nennt ein Laufzeitfehler? Nur bekannte, generierte Pfade werden akzeptiert. */
export function locateFailingFile(detail, files) {
  const text = String(detail || '');
  for (const path of files.keys()) {
    if (text.includes(path)) return path;
  }
  const moduleMatch = /(?:Cannot find module|ERR_MODULE_NOT_FOUND[^\n]*?)\s+['"]?([./][^'"\s)]+)['"]?/.exec(text);
  if (moduleMatch) {
    const cleaned = moduleMatch[1].replace(/^\.\//, '');
    if (files.has(cleaned)) return cleaned;
  }
  return null;
}

const REPAIRABLE = new Set([
  'MISSING_FILE', 'EMPTY_FILE', 'CONTENT_DRIFT', 'SYNTAX_ERROR', 'JSX_STRUCTURE',
  'PLACEHOLDER_FOUND', 'SECRET_PATTERN_FOUND', 'HOST_PATH_FOUND', 'PRIVATE_KEY_MATERIAL',
  'ROUTE_GUARD_MISSING', 'ROUTE_METHOD_MISSING', 'PRISMA_MODEL_MISSING', 'MIGRATION_TABLE_MISSING',
  'CONTRACT_MISSING_FILE', 'AUTH_MIDDLEWARE_MISSING', 'TOKEN_CHECK_WEAK', 'PASSWORD_HASH_MISSING',
  'TEST_RUN_FAILED', 'TEST_FAILED',
]);

/**
 * Wendet Reparaturen an. Rueckgabe enthaelt je Datei einen Patch-Nachweis und
 * die Befunde, die bewusst nicht repariert werden (Eskalation).
 */
export function repairProject(root, manifest, verification, { write = writeFileSync, maxFiles = 12 } = {}) {
  const files = buildFileMap(manifest);
  const patches = [];
  const escalated = [];
  const handled = new Set();

  for (const failure of verification.failures || []) {
    if (handled.size >= maxFiles) break;
    if (!REPAIRABLE.has(failure.code)) {
      escalated.push({ code: failure.code, detail: failure.detail, reason: 'not_repairable' });
      continue;
    }
    const target = failure.file || locateFailingFile(failure.detail, files);
    if (!target) {
      escalated.push({ code: failure.code, detail: failure.detail, reason: 'file_unknown' });
      continue;
    }
    const template = templateFor(files, target);
    if (!template) {
      escalated.push({ code: failure.code, detail: failure.detail, file: target, reason: 'no_template' });
      continue;
    }
    if (handled.has(target)) continue;

    const absolute = join(root, target);
    const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
    if (before === template) {
      escalated.push({ code: failure.code, detail: failure.detail, file: target, reason: 'template_unchanged' });
      continue;
    }
    write(absolute, template, 'utf8');
    handled.add(target);
    patches.push({
      file: target,
      action: before ? 'rewrite' : 'create',
      code: failure.code,
      reason: String(failure.detail || '').slice(0, 200),
      diff: summarizeDiff(before, template),
      sha256: createHash('sha256').update(template).digest('hex'),
    });
  }

  return { patches, escalated, repaired: patches.length };
}
