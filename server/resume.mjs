import { db } from './db.mjs';
import { orchestrate } from './agents.mjs';
import { enqueueVillas, configureScheduler, villaRanking, villaRunToCompletion } from './scheduler.mjs';

/**
 * Setzt Laeufe fort, die durch einen Neustart abgebrochen wurden.
 *
 * Eine Villa steht nur dann auf RUNNING, wenn ein Lauf lief. Bleibt der Status
 * nach einem Neustart auf RUNNING stehen, wurde der Prozess abgebrochen.
 *
 * Nicht mehr alle gleichzeitig und auch nicht nach der Uhr gestaffelt:
 * Der Scheduler startet die Villen mit dem weitesten Fortschritt zuerst und
 * haelt nur VF_VILLA_SLOTS Villen gleichzeitig am Laufen. Die uebrigen rutschen
 * automatisch nach, sobald ein Lauf endet - so werden frueher vollstaendige
 * Ergebnisse geliefert statt vieler halbfertiger Villen.
 */
export function resumePendingVillas({ concurrency = 0, maxRounds = 6 } = {}) {
  const stuck = db.prepare('SELECT id, name FROM villas WHERE status = ? AND autonomy = 1').all('RUNNING');
  if (!stuck.length) return { resumed: 0, villas: [] };

  configureResumeScheduler({ concurrency, maxRounds });
  const ids = stuck.map((v) => v.id);
  const status = enqueueVillas(ids);

  const order = villaRanking().map((r) => r.id).filter((id) => ids.includes(id));
  console.log(`[villaforge] ${order.length} unterbrochene Villa(s) nach Fortschritt eingereiht (weiteste zuerst): ${order.join(', ')}`);
  return { resumed: order.length, villas: order, scheduler: status };
}

export function configureResumeScheduler({ concurrency = 0, maxRounds = 6, start = orchestrate } = {}) {
  configureScheduler({ start: (id) => start(id, { concurrency, maxRounds, runToCompletion: villaRunToCompletion(id) }) });
}
