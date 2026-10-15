import { db, now } from './db.mjs';

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function fingerprint(villa) {
  const source = normalize(villa.source_path);
  const idea = normalize(villa.idea);
  const name = normalize(villa.name);
  if (source) return `source:${source}`;
  return `content:${name}|${idea}`;
}

export function findDuplicateGroups() {
  const villas = db.prepare('SELECT id, name, idea, source_path, status, created_at, updated_at FROM villas ORDER BY created_at ASC, id ASC').all();
  const groups = new Map();
  for (const villa of villas) {
    const key = fingerprint(villa);
    if (!key || key.endsWith('|')) continue;
    const list = groups.get(key) || [];
    list.push(villa);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({
      key,
      keep: list[0],
      duplicates: list.slice(1),
      count: list.length
    }));
}

export function duplicateSummary() {
  const groups = findDuplicateGroups();
  return {
    groups,
    duplicateCount: groups.reduce((sum, group) => sum + group.duplicates.length, 0),
    keptCount: groups.length,
    generatedAt: now()
  };
}

function deleteVillaData(id) {
  for (const table of ['tasks', 'agents', 'messages', 'memories', 'audit', 'sources', 'reports', 'council']) {
    db.prepare(`DELETE FROM ${table} WHERE villa_id = ?`).run(id);
  }
  db.prepare('DELETE FROM villas WHERE id = ?').run(id);
}

/**
 * Entfernt ausschließlich IDs, die der Aufrufer vorher aus duplicateSummary()
 * erhalten hat. Ohne apply=true wird niemals geschrieben.
 */
export function removeDuplicates(ids, { isRunning = () => false } = {}) {
  const requested = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  const allowed = new Set(findDuplicateGroups().flatMap((g) => g.duplicates.map((v) => v.id)));
  const result = { applied: [], skipped: [], unknown: [] };
  for (const id of requested) {
    if (!allowed.has(id)) { result.unknown.push(id); continue; }
    if (isRunning(id)) { result.skipped.push({ id, reason: 'Villa läuft gerade' }); continue; }
    const villa = db.prepare('SELECT id, name FROM villas WHERE id = ?').get(id);
    if (!villa) { result.unknown.push(id); continue; }
    deleteVillaData(id);
    result.applied.push(villa);
  }
  return result;
}
