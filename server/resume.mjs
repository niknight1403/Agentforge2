import { db } from './db.mjs';
import { orchestrate, isRunning } from './agents.mjs';
import { enqueueVillas, configureScheduler, villaRanking } from './scheduler.mjs';

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

  // Nicht alle gleichzeitig: der Scheduler startet die Villen mit dem
  // weitesten Fortschritt zuerst und haelt nur VF_VILLA_SLOTS gleichzeitig am
  // Laufen; die uebrigen rutschen nach, sobald ein Slot frei wird.
  configureScheduler({ start: (id) => orchestrate(id, { concurrency, maxRounds }) });
  const ids = stuck.map((v) => v.id).filter((id) => !isRunning(id));
  if (!ids.length) return { resumed: 0, villas: [] };
  enqueueVillas(ids);

  const order = villaRanking().map((r) => r.id).filter((id) => ids.includes(id));
  console.log(`[villaforge] ${order.length} unterbrochene Villa(s) nach Fortschritt eingereiht (weiteste zuerst): ${order.join(', ')}`);
  return { resumed: order.length, villas: order };
}
