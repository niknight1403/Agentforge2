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

  // Optional gestaffelt (VF_RESUME_STAGGER_MS): Bei vielen unterbrochenen
  // Villen wuerde ein gleichzeitiger Start den Hub direkt nach dem Neustart
  // ueberlasten. Standard 0 = sofort (Verhalten und Tests unveraendert).
  const stagger = Math.max(0, Number(process.env.VF_RESUME_STAGGER_MS ?? 0) || 0);
  const resumed = [];
  for (const v of stuck) {
    if (isRunning(v.id)) continue;
    const delay = resumed.length * stagger;
    const start = () => {
      if (isRunning(v.id)) return;
      // Nicht auf das Ergebnis warten: der Lauf soll den Serverstart nicht blockieren.
      orchestrate(v.id, { concurrency, maxRounds }).catch((err) => {
        console.error(`[villaforge] Wiederaufnahme von Villa ${v.id} fehlgeschlagen:`, err.message || err);
      });
    };
    if (delay > 0) setTimeout(start, delay).unref();
    else start();
    resumed.push(v.id);
  }
  if (resumed.length) {
    console.log(`[villaforge] ${resumed.length} unterbrochene Villa(s) werden fortgesetzt: ${resumed.join(', ')}`);
  }
  return { resumed: resumed.length, villas: resumed };
}
