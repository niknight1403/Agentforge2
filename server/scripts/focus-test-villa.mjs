import { db, now } from '../db.mjs';

const normalize = (name) => String(name || '').toLocaleLowerCase('de-DE').replace(/[\s_-]+/g, '');
const allVillas = db.prepare('SELECT id,name,status FROM villas').all();
const active = allVillas.filter((villa) => villa.status !== 'ARCHIVED');
const targets = active.filter((villa) => normalize(villa.name) === 'testneu');
const retiring = allVillas.filter((villa) => normalize(villa.name) === 'testvilla');

if (targets.length !== 1) {
  console.error(JSON.stringify({
    ok: false,
    error: targets.length ? 'Mehrere aktive Villen namens testneu gefunden; es wurde nichts geändert.' : 'Die aktive Villa testneu fehlt; Test Villa wurde aus Sicherheitsgründen nicht gelöscht.',
    targetMatches: targets.map(({ id, name }) => ({ id, name }))
  }));
  process.exitCode = 1;
} else if (retiring.length > 1) {
  console.error(JSON.stringify({ ok: false, error: 'Mehrere Villen namens Test Villa gefunden; es wurde nichts gelöscht.', matches: retiring.map(({ id, name }) => ({ id, name })) }));
  process.exitCode = 1;
} else {
  const target = targets[0];
  const oldVilla = retiring[0] || null;
  if (oldVilla?.id === target.id) {
    console.error(JSON.stringify({ ok: false, error: 'Ziel und zu löschende Villa dürfen nicht identisch sein.' }));
    process.exitCode = 1;
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = now();
      db.prepare("UPDATE villas SET autonomy=0,status=CASE WHEN status IN ('RUNNING','PLANNING','STOPPING') THEN 'PAUSED' ELSE status END,updated_at=? WHERE id != ? AND status != 'ARCHIVED'").run(timestamp, target.id);

      const deletedRows = {};
      if (oldVilla) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        for (const { name } of tables) {
          if (name === 'villas') continue;
          const quoted = '"' + String(name).replaceAll('"', '""') + '"';
          const hasVillaId = db.prepare(`PRAGMA table_info(${quoted})`).all().some((column) => column.name === 'villa_id');
          if (!hasVillaId) continue;
          const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoted} WHERE villa_id=?`).get(oldVilla.id).count);
          if (count > 0) {
            deletedRows[name] = count;
            db.prepare(`DELETE FROM ${quoted} WHERE villa_id=?`).run(oldVilla.id);
          }
        }
        db.prepare('DELETE FROM villas WHERE id=?').run(oldVilla.id);
      }

      const open = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY','RUNNING')").get(target.id).count);
      db.prepare("UPDATE villas SET autonomy=1,status=CASE WHEN ? > 0 AND status NOT IN ('ARCHIVED','COMPLETED') THEN 'RUNNING' ELSE status END,updated_at=? WHERE id=?").run(open, timestamp, target.id);
      db.prepare('INSERT OR REPLACE INTO control_settings(key,value) VALUES (?,?)').run('villaFocusId', JSON.stringify(target.id));

      const remaining = Number(db.prepare('SELECT COUNT(*) AS count FROM villas WHERE id=?').get(target.id).count);
      const focus = db.prepare("SELECT value FROM control_settings WHERE key='villaFocusId'").get()?.value;
      const otherAutonomous = Number(db.prepare("SELECT COUNT(*) AS count FROM villas WHERE id != ? AND status != 'ARCHIVED' AND autonomy=1").get(target.id).count);
      const oldRemaining = oldVilla ? Number(db.prepare('SELECT COUNT(*) AS count FROM villas WHERE id=?').get(oldVilla.id).count) : 0;
      if (!remaining || Number(JSON.parse(focus || 'null')) !== target.id || otherAutonomous !== 0 || oldRemaining !== 0) {
        throw new Error('Villa-Wechsel konnte nicht vollständig verifiziert werden.');
      }

      db.exec('COMMIT');
      console.log(JSON.stringify({
        ok: true,
        focusVillaId: target.id,
        focusVilla: target.name,
        stoppedAndDeletedVillaId: oldVilla?.id ?? null,
        stoppedAndDeletedVilla: oldVilla?.name ?? null,
        deletedRows,
        activeVillaCount: 1,
        otherAutonomousVillas: otherAutonomous,
        openTasks: open
      }));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
  }
}
