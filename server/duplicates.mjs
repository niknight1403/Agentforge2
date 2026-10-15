import { db, now } from './db.mjs';
import './control-store.mjs';
export const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
export function villaKey(v) { return JSON.stringify([normalize(v.name), normalize(v.idea), String(v.source_path ?? v.sourcePath ?? '').trim().replace(/\/$/, '')]); }
export function duplicateGroups(isRunning = () => false) {
  const groups = new Map();
  const rows = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM tasks t WHERE t.villa_id=v.id AND t.status='DONE') AS done,
    (SELECT COUNT(*) FROM tasks t WHERE t.villa_id=v.id) AS total FROM villas v
    WHERE v.id NOT IN (SELECT villa_id FROM control_archives) ORDER BY id`).all();
  for (const v of rows) {
    if (!normalize(v.name) || !normalize(v.idea)) continue;
    const key = villaKey(v); if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...v, active: !!isRunning(v.id) });
  }
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    g.sort((a,b) => Number(b.active) - Number(a.active) || b.done - a.done || b.total - a.total || a.id - b.id);
    return { keep: g[0].id, name: g[0].name, duplicates: g.slice(1).map(v => ({ id: v.id, active: v.active, done: v.done, total: v.total })) };
  });
}
/** Reversible cleanup: all project content and workspace files remain intact. */
export function archiveDuplicates(isRunning = () => false) {
  const groups = duplicateGroups(isRunning); const archived = [], skipped = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const g of groups) for (const d of g.duplicates) {
      if (isRunning(d.id)) { skipped.push(d.id); continue; }
      const v = db.prepare('SELECT status,autonomy FROM villas WHERE id=?').get(d.id);
      db.prepare('INSERT INTO control_archives VALUES (?,?,?,?,?)').run(d.id, g.keep, v.status, v.autonomy, now());
      db.prepare("UPDATE villas SET status='ARCHIVED', autonomy=0, updated_at=? WHERE id=?").run(now(), d.id);
      archived.push({ id: d.id, kept: g.keep });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { archived, skipped, groups: groups.length, preserved: true };
}
export function restoreVilla(id) {
  const row = db.prepare('SELECT * FROM control_archives WHERE villa_id=?').get(id);
  if (!row) throw new Error('Villa ist nicht archiviert.');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Restore paused; restoring content must not silently restart paid model work.
    db.prepare("UPDATE villas SET status='PAUSED', autonomy=0, updated_at=? WHERE id=?").run(now(), id);
    db.prepare('DELETE FROM control_archives WHERE villa_id=?').run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { restored: id, status: 'PAUSED' };
}
