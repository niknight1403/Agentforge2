/*
 * repo-target (Issue #130): Zielrepositorys von Villen verbindlich festhalten.
 *
 * Ein Vorschlag des Innovations-Scouts ist nur dann eine INTEGRATION oder ein
 * SUBPROJECT, wenn das Ziel (owner/name, Branch, optionaler Unterpfad) eindeutig
 * belegt ist. Namensaehnlichkeit ist kein Beweis - deshalb wird eine Villa-
 * Bindung ausschliesslich aus einer ausdruecklich gespeicherten Zuordnung oder
 * aus dem echten Git-Remote ihres Quellordners abgeleitet.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db, now } from './db.mjs';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** 'https://github.com/o/r.git', 'git@github.com:o/r.git' oder 'o/r' -> 'o/r'. */
export function normalizeRepo(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';
  raw = raw
    .replace(/^https?:\/\/(?:[^@/\s]+@)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  // Nur exakt zwei Segmente: owner/name.
  const parts = raw.split('/');
  if (parts.length !== 2) return '';
  const [owner, name] = parts;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return '';
  return `${owner}/${name}`;
}

/** Branch muss explizit und git-kompatibel sein; '..' und fuehrende '-' sind tabu. */
export function normalizeBranch(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 200) return '';
  if (!BRANCH_RE.test(raw)) return '';
  if (raw.includes('..') || raw.startsWith('-') || raw.startsWith('/') || raw.endsWith('/') || raw.endsWith('.lock')) return '';
  return raw;
}

/** Unterpfad im Zielrepo: relativ, ohne Ausbruch aus dem Repo. */
export function normalizeTargetPath(value) {
  let raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw || raw === '.' || raw === './') return '';
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/')) throw new Error('Zielpfad muss relativ zum Repository sein.');
  raw = raw.replace(/^\.\//, '').replace(/\/+$/g, '');
  if (!raw) return '';
  const segments = raw.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error('Zielpfad darf keine leeren Segmente oder ".." enthalten.');
  return segments.join('/');
}

/** Liest das Remote 'origin' direkt aus .git/config (kein git-Binary noetig). */
export function gitRemoteOf(directory) {
  const dir = String(directory ?? '').trim();
  if (!dir) return '';
  const config = join(resolve(dir), '.git', 'config');
  if (!existsSync(config)) return '';
  let text = '';
  try { text = readFileSync(config, 'utf8'); } catch { return ''; }
  const section = text.split(/^\[/m).find((block) => /^remote "origin"\]/.test(block));
  if (!section) return '';
  const match = section.match(/^\s*url\s*=\s*(.+)$/m);
  return match ? normalizeRepo(match[1]) : '';
}

/** Verbindliche Zuordnung Villa -> Repository (idempotent). */
export function bindVillaRepo(villaId, { repo, branch = '', path = '' } = {}) {
  const id = Number(villaId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Ungueltige Villa-ID fuer die Repository-Bindung.');
  const normalized = normalizeRepo(repo);
  if (!normalized) throw new Error(`Ungueltiges Repository: ${String(repo || 'leer')}`);
  const targetBranch = normalizeBranch(branch);
  const targetPath = normalizeTargetPath(path);
  const meta = JSON.stringify({ repo: normalized, branch: targetBranch, path: targetPath });
  const existing = db.prepare("SELECT id, meta FROM sources WHERE villa_id = ? AND kind = 'GITHUB' ORDER BY id DESC").all(id);
  if (existing.some((row) => row.meta === meta)) return { villaId: id, repo: normalized, branch: targetBranch, path: targetPath, created: false };
  db.prepare('INSERT INTO sources (villa_id, path, kind, meta, created_at) VALUES (?,?,?,?,?)')
    .run(id, '', 'GITHUB', meta, now());
  return { villaId: id, repo: normalized, branch: targetBranch, path: targetPath, created: true };
}

/** Repository einer Villa: gespeicherte Bindung zuerst, sonst echtes Git-Remote. */
export function villaRepo(villaId, { remoteOf = gitRemoteOf } = {}) {
  const id = Number(villaId);
  const row = db.prepare("SELECT meta FROM sources WHERE villa_id = ? AND kind = 'GITHUB' ORDER BY id DESC LIMIT 1").get(id);
  if (row?.meta) {
    try {
      const meta = JSON.parse(row.meta);
      const repo = normalizeRepo(meta.repo);
      if (repo) return { repo, branch: normalizeBranch(meta.branch), path: normalizeTargetPath(meta.path) };
    } catch { /* naechste Quelle versuchen */ }
  }
  const villa = db.prepare('SELECT source_path FROM villas WHERE id = ?').get(id);
  const repo = remoteOf(villa?.source_path || '');
  return repo ? { repo, branch: '', path: '' } : null;
}

/**
 * Alle Villen je Repository. Mehr als eine Villa pro Repository ist eine
 * Mehrdeutigkeit, die vor einer Freigabe geklaert werden muss.
 */
export function villaRepoMap({ villas, remoteOf = gitRemoteOf } = {}) {
  const rows = Array.isArray(villas) ? villas : db.prepare('SELECT id, name, status, source_path FROM villas ORDER BY id').all();
  const map = new Map();
  for (const villa of rows) {
    const binding = villaRepo(villa.id, { remoteOf });
    if (!binding) continue;
    const list = map.get(binding.repo) || [];
    list.push({ id: Number(villa.id), name: villa.name || `Villa ${villa.id}`, status: villa.status || '', branch: binding.branch, path: binding.path });
    map.set(binding.repo, list);
  }
  return map;
}

/** Villen, die nachweislich auf dieses Repository zeigen. */
export function villasForRepo(repo, options = {}) {
  const normalized = normalizeRepo(repo);
  if (!normalized) return [];
  return villaRepoMap(options).get(normalized) || [];
}
