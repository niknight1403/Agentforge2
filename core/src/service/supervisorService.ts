/**
 * Agentforge2 Supervisor-Service — Daemon der selbstheilenden Architektur.
 * Laeuft als systemd-Prozess (villaforge-supervisor.service) neben dem Hub.
 *
 * Selbstheilungs-Interventionen je Sweep (konservativ und bewaehrt):
 *  1. FAILED-Explosion: >= 25 gescheiterte Aufgaben -> Bereinigung der
 *     Leichen + wartender VERIFICATION-Spam (gleiche Kaskade wie villa-control).
 *  2. VERIFICATION-Doppelungen: > 3 wartende Verifikationstasks -> nur die
 *     neueste behalten, Rest entfernen.
 *  3. Loop-Erkennung: die letzten Tool-Nachrichten je Villa werden als
 *     ExecutionStep-Historie an den HierarchicalSupervisor uebergeben;
 *     identische Wiederholungen werden als Anomalie geloggt.
 */
import { DatabaseSync } from 'node:sqlite';
import { HierarchicalSupervisor, ExecutionStep } from '../supervisor/HierarchicalSupervisor.js';

const DB_PATH = process.env.VF_DB || '/opt/villaforge/server/data/villaforge.db';
const INTERVAL_MS = Number(process.env.SUPERVISOR_INTERVAL_MS || 300_000);
const FAILED_THRESHOLD = Number(process.env.SUPERVISOR_FAILED_THRESHOLD || 25);

const supervisor = new HierarchicalSupervisor({ maxRepetitions: 3, maxRetries: 3 });
const log = (...args: any[]) => console.log(new Date().toISOString(), '[SupervisorService]', ...args);

function stepFromMessage(row: { tool: string | null; content: string }): ExecutionStep {
  const content = String(row.content ?? '');
  const toolName = (row.tool && String(row.tool).trim()) || 'unknown';
  return { toolName, arguments: { digest: content.slice(0, 120) } };
}

async function sweep(): Promise<void> {
  const db = new DatabaseSync(DB_PATH, { readOnly: false });
  try {
    const villas = db.prepare("SELECT id, name, status, autonomy FROM villas WHERE status != 'ARCHIVED'").all() as any[];
    for (const villa of villas) {
      const stats = db.prepare(
        'SELECT status, COUNT(*) AS c FROM tasks WHERE villa_id = ? GROUP BY status'
      ).all(villa.id) as any[];
      const by = (s: string) => Number(stats.find((r) => r.status === s)?.c || 0);

      // --- Intervention 1: FAILED-Explosion ---
      if (by('FAILED') >= FAILED_THRESHOLD) {
        const f = db.prepare("DELETE FROM tasks WHERE villa_id = ? AND status = 'FAILED'").run(villa.id);
        const v = db.prepare("DELETE FROM tasks WHERE villa_id = ? AND status = 'PENDING' AND title LIKE '[VERIFICATION]%'").run(villa.id);
        log(`INTERVENTION FAILED-Explosion Villa ${villa.id} (${villa.name}): ${f.changes} FAILED und ${v.changes} VERIFICATION-Spam entfernt`);
      }

      // --- Intervention 2: VERIFICATION-Doppelungen ---
      const dup = db.prepare(
        "SELECT id FROM tasks WHERE villa_id = ? AND status = 'PENDING' AND title LIKE '[VERIFICATION]%' ORDER BY id ASC"
      ).all(villa.id) as any[];
      if (dup.length > 3) {
        const keep = new Set(dup.slice(-3).map((r) => r.id));
        const remove = dup.filter((r) => !keep.has(r.id));
        for (const r of remove) db.prepare('DELETE FROM tasks WHERE id = ?').run(r.id);
        log(`INTERVENTION VERIFICATION-Doppelung Villa ${villa.id}: ${remove.length} ueberfluessige Wartende entfernt (3 neueste behalten)`);
      }

      // --- Intervention 3: Loop-Erkennung via HierarchicalSupervisor ---
      const msgs = db.prepare(
        'SELECT tool, content FROM messages WHERE villa_id = ? AND tool IS NOT NULL ORDER BY id DESC LIMIT 30'
      ).all(villa.id) as any[];
      if (msgs.length > 0) {
        const history: ExecutionStep[] = msgs.map(stepFromMessage).reverse();
        const anomaly = supervisor.analyzeExecution(history);
        if (anomaly.hasAnomaly) {
          const intervention = supervisor.handleIntervention(`villa-${villa.id}`, anomaly, `Mission: ${villa.name}`);
          log(`ANOMALIE Villa ${villa.id} (${villa.name}): ${anomaly.type} -> ${intervention.action}. ${anomaly.details}`);
        }
      }
    }
    const counts = db.prepare("SELECT COUNT(*) AS c FROM villas WHERE autonomy = 1 AND status != 'ARCHIVED'").get() as any;
    log(`Sweep ok: ${villas.length} Villen geprueft, ${counts.c} mit Autonomy=1.`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  log('Supervisor-Service gestartet. Intervall:', Math.round(INTERVAL_MS / 1000) + 's', '| DB:', DB_PATH);
  while (true) {
    try {
      await sweep();
    } catch (err: any) {
      log('Sweep-Fehler (naechster Versuch nach Intervall):', err?.message || err);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((err) => {
  log('Fatal:', err?.message || err);
  process.exit(1);
});
