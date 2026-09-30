import { db } from './db.mjs';
import { orchestrate, isRunning } from './agents.mjs';

/**
 * Setzt Laeufe fort, die durch einen Neustart abgebrochen wurden.
 *
 * Eine Villa steht nur dann auf RUNNING, wenn ein Lauf lief. Bleibt der Status
 * nach einem Neustart auf RUNNING stehen, wurde der Prozess abgebrochen. Diese
 * Villen werden hier wieder aufgenommen, sofern der Nutzer die Autonomie nicht
 * ausdruecklich abgeschaltet hat (autonomy = 0).
 *
 * Bewusst keine Endlosschleife: jede Villa wird einmal angestossen. Die Runden
 * der Selbstheilung sind in orchestrate() gedeckelt, damit der Lauf endet.
 */
export function resumePendingVillas({ concurrency = 4, maxRounds = 6 } = {}) {
  const stuck = db.prepare('SELECT id, name FROM villas WHERE status = ? AND autonomy = 1').all('RUNNING');
  if (!stuck.length) return { resumed: 0, villas: [] };

  const resumed = [];
  for (const v of stuck) {
    if (isRunning(v.id)) continue;
    // Nicht auf das Ergebnis warten: der Lauf soll den Serverstart nicht blockieren.
    orchestrate(v.id, { concurrency, maxRounds }).catch((err) => {
      console.error(`[villaforge] Wiederaufnahme von Villa ${v.id} fehlgeschlagen:`, err.message || err);
    });
    resumed.push(v.id);
  }
  if (resumed.length) {
    console.log(`[villaforge] ${resumed.length} unterbrochene Villa(s) werden fortgesetzt: ${resumed.join(', ')}`);
  }
  return { resumed: resumed.length, villas: resumed };
}
