import { db, now } from '../db.mjs';

const villas = db.prepare("SELECT id,name,status FROM villas WHERE status != 'ARCHIVED'").all();
const normalize = (name) => String(name || '').toLocaleLowerCase('de-DE').replace(/[\s_-]+/g, '');
const matches = villas.filter((villa) => normalize(villa.name) === 'testvilla');
if (matches.length !== 1) {
  console.error(JSON.stringify({ ok: false, error: matches.length ? 'Mehrere Villen namens Test Villa gefunden; Fokus wurde nicht geändert.' : 'Keine vorhandene Villa namens Test Villa gefunden; Fokus wurde nicht geändert.', matches: matches.map(({ id, name }) => ({ id, name })) }));
  process.exitCode = 1;
} else {
  const target = matches[0];
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR REPLACE INTO control_settings(key,value) VALUES (?,?)').run('villaFocusId', JSON.stringify(target.id));
    db.prepare("UPDATE villas SET autonomy=0,status=CASE WHEN status IN ('RUNNING','PLANNING','STOPPING') THEN 'PAUSED' ELSE status END,updated_at=? WHERE id != ? AND status != 'ARCHIVED'").run(timestamp, target.id);
    const open = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY','RUNNING')").get(target.id).count;
    db.prepare("UPDATE villas SET autonomy=1,status=CASE WHEN ? > 0 AND status NOT IN ('ARCHIVED','COMPLETED') THEN 'RUNNING' ELSE status END,updated_at=? WHERE id=?").run(open, timestamp, target.id);
    const others = db.prepare("SELECT COUNT(*) AS count FROM villas WHERE id != ? AND status != 'ARCHIVED' AND autonomy=1").get(target.id).count;
    if (others) throw new Error(`${others} other Villa(s) remain autonomous; focus activation failed.`);
    db.exec('COMMIT');
    console.log(JSON.stringify({ ok: true, focusVillaId: target.id, focusVilla: target.name, activeVillaCount: 1, otherAutonomousVillas: others, openTasks: open }));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
