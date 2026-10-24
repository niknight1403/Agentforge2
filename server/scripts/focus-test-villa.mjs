import { db, now } from '../db.mjs';

// Produktionsfokus: genau diese zwei Villen bleiben aktiv, alle anderen
// werden geparkt. Legacy-Testvillen (testneu/testvilla) werden samt Daten
// entfernt. Kein Einzel-Fokus mehr (villaFocusId wird geloescht) — der
// Scheduler verteilt die Laeufe wieder fair auf beide Villen.
const normalize = (name) => String(name || '').toLocaleLowerCase('de-DE').replace(/[\s_-]+/g, '');
const FOCUS_NAMES = ['cybersarahvilla', 'autonomousrevenueenginetarget7keurmrr'];
const LEGACY_NAMES = ['testneu', 'testvilla'];

const allVillas = db.prepare('SELECT id,name,status FROM villas').all();
const active = allVillas.filter((villa) => villa.status !== 'ARCHIVED');
const targets = active.filter((villa) => FOCUS_NAMES.includes(normalize(villa.name)));
const retiring = allVillas.filter((villa) => LEGACY_NAMES.includes(normalize(villa.name)));

if (targets.length !== FOCUS_NAMES.length) {
  console.error(JSON.stringify({
    ok: false,
    error: 'Produktionsvillen unvollstaendig; es wurde nichts geaendert.',
    expected: FOCUS_NAMES,
    targetMatches: targets.map(({ id, name }) => ({ id, name }))
  }));
  process.exitCode = 1;
} else {
  const targetIds = targets.map((v) => v.id);
  const uniqueFocus = new Set(targets.map((v) => normalize(v.name)));
  if (uniqueFocus.size !== FOCUS_NAMES.length) {
    console.error(JSON.stringify({ ok: false, error: 'Jede Produktionsvilla darf nur einmal vorkommen.' }));
    process.exitCode = 1;
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = now();
      const ph = targetIds.map(() => '?').join(',');
      db.prepare(`UPDATE villas SET autonomy=0,status=CASE WHEN status IN ('RUNNING','PLANNING','STOPPING') THEN 'PAUSED' ELSE status END,updated_at=? WHERE id NOT IN (${ph}) AND status != 'ARCHIVED'`).run(timestamp, ...targetIds);

      const deletedRows = {};
      for (const oldVilla of retiring) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        for (const { name } of tables) {
          if (name === 'villas') continue;
          const quoted = '"' + String(name).replaceAll('"', '""') + '"';
          const hasVillaId = db.prepare(`PRAGMA table_info(${quoted})`).all().some((column) => column.name === 'villa_id');
          if (!hasVillaId) continue;
          const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoted} WHERE villa_id=?`).get(oldVilla.id).count);
          if (count > 0) {
            deletedRows[name] = (deletedRows[name] || 0) + count;
            db.prepare(`DELETE FROM ${quoted} WHERE villa_id=?`).run(oldVilla.id);
          }
        }
        db.prepare('DELETE FROM villas WHERE id=?').run(oldVilla.id);
      }

      for (const target of targets) {
        const open = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY','RUNNING')").get(target.id).count);
        db.prepare("UPDATE villas SET autonomy=1,status=CASE WHEN ? > 0 AND status NOT IN ('ARCHIVED','COMPLETED') THEN 'RUNNING' ELSE status END,updated_at=? WHERE id=?").run(open, timestamp, target.id);
      }
      db.prepare("DELETE FROM control_settings WHERE key='villaFocusId'").run();

      const remaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM villas WHERE id IN (${ph})`).get(...targetIds).count);
      const focusRow = db.prepare("SELECT value FROM control_settings WHERE key='villaFocusId'").get()?.value;
      const otherAutonomous = Number(db.prepare(`SELECT COUNT(*) AS count FROM villas WHERE id NOT IN (${ph}) AND status != 'ARCHIVED' AND autonomy=1`).get(...targetIds).count);
      const retiredRemaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM villas WHERE id IN (${retiring.map(() => '?').join(',') || "''"})`).get(...retiring.map((v) => v.id)).count);
      if (remaining !== targetIds.length || focusRow !== undefined || otherAutonomous !== 0 || retiredRemaining !== 0) {
        throw new Error('Fokus-Wechsel konnte nicht vollstaendig verifiziert werden: ' + JSON.stringify({ remaining, erwartung: targetIds.length, focusRow, otherAutonomous, retiredRemaining }));
      }

      db.exec('COMMIT');
      console.log(JSON.stringify({
        ok: true,
        focusVillas: targets.map(({ id, name }) => ({ id, name })),
        removedLegacyVillas: retiring.map(({ id, name }) => ({ id, name })),
        deletedRows,
        otherAutonomousVillas: otherAutonomous,
        activeVillaCount: targetIds.length
      }));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
  }
}
