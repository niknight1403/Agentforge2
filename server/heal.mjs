// Heil-Kern: autonomes Selbstheilungs- und Pruefmodul.
// Der Takt prueft das GESAMTE System (Villen, Aufgaben, LLM-Routen,
// Warteschlange), analysiert Fehler selbststaendig per LLM, leitet
// Reparatur-Aufgaben ein und genehmigt sie automatisch - der Administrator
// hat Vollautonomie angeordnet. Erst wenn ALLES gruen ist, kehrt das
// System zur reinen Ueberwachung zurueck.
import { db, now } from './db.mjs';
import { proposeForVilla, approveVillaProposal } from './evolve.mjs';

const DAY = 24 * 60 * 60 * 1000;

let lastAudit = null;
let lastActions = [];

/** Kompletter System-Check: welchem Bereich ist gruen/rot und warum. */
/* DB-Hygiene: NULL-Inhalte in memories sind ein Latenz-Bug - jedes
 * memoryContext() im Aufgabenpfad wuerde daran crashen (undefined.slice).
 * Aeltere Hub-Versionen konnten NULL schreiben; der Takt heilt das nach. */
export function healMemoryContents() {
  const r = db.prepare("UPDATE memories SET content = '' WHERE content IS NULL").run();
  return r.changes;
}

export function systemAudit() {
  const q = (sql, ...a) => db.prepare(sql).get(...a).c;
  const failed24h = q("SELECT COUNT(*) c FROM tasks WHERE status = 'FAILED' AND villa_id IN (SELECT id FROM villas WHERE status != 'ARCHIVED') AND updated_at > ?", now() - DAY);
  // Heiss = Villa mit >= 2 Fehlschlaegen (dort greift der Heil-Takt).
  // Einzelne Fehlschlaege werden von der Aufgaben-Wiederholung selbst geheilt.
  const hotRows = db.prepare("SELECT villa_id, MAX(updated_at) mf FROM tasks WHERE status = 'FAILED' AND villa_id IN (SELECT id FROM villas WHERE status != 'ARCHIVED') AND updated_at > ? GROUP BY villa_id HAVING COUNT(*) >= 2").all(now() - DAY);
  let hot = 0;
  for (const h of hotRows) {
    const d = db.prepare("SELECT MAX(updated_at) m FROM tasks WHERE villa_id = ? AND status = 'DONE'").get(h.villa_id);
    // Villa in Erholung: produziert NACH dem letzten Fehler wieder DONE.
    if (!d || !d.m || d.m < h.mf) hot++;
  }
  const totalRoutes = q("SELECT COUNT(*) c FROM routes WHERE enabled = 1");
  const cooldownRoutes = q('SELECT COUNT(*) c FROM routes WHERE cooldown_until > ? AND enabled = 1', now());
  const backlog = q("SELECT COUNT(*) c FROM tasks WHERE status = 'PENDING'");
  // Zombie = RUNNING seit MEHR als 40 Min ohne Fortschritt (Reaper greift ab 35).
  const stale = q("SELECT COUNT(*) c FROM tasks WHERE status = 'RUNNING' AND updated_at < ?", now() - 40 * 60 * 1000);
  const villas = q("SELECT COUNT(*) c FROM villas WHERE status IN ('RUNNING','ACTIVE')");
  const done30 = q("SELECT COUNT(*) c FROM tasks WHERE status = 'DONE' AND updated_at > ?", now() - 30 * 60 * 1000);
  const llmGreen = cooldownRoutes < totalRoutes || done30 > 5;
  const areas = [
    { name: 'Aufgaben', green: hot === 0, detail: hot === 0 ? `keine Fehlerhaeufungen (24 h, ${failed24h} Einzelfehlschlaege)` : `${hot} Villa(s) mit >= 2 Fehlschlaeufen (24 h)` },
    { name: 'LLM-Routen', green: llmGreen, detail: cooldownRoutes === 0 ? `alle ${totalRoutes} Routen frei, ${done30} Aufgaben fertig (30 Min)` : `${cooldownRoutes}/${totalRoutes} Route(s) im Cooldown, ${done30} Aufgaben fertig (30 Min)` },
    { name: 'Warteschlange', green: backlog < 400, detail: `${backlog} offene Aufgaben` },
    { name: 'Zombies', green: stale === 0, detail: stale === 0 ? 'keine haengenden Laeufe' : `${stale} Lauf/laeufe > 40 Min` },
    { name: 'Villen', green: villas > 0, detail: `${villas} aktive Villa(s)` }
  ];
  lastAudit = { green: areas.every((a) => a.green), areas, ts: now() };
  return lastAudit;
}

/** Letzter Audit (fuer die API, ohne Neuberechnung). */
export function lastAuditResult() {
  return lastAudit || systemAudit();
}

/** Letzte autonome Heil-Aktionen (Nachvollziehbarkeit in der App). */
export function healActions() { return lastActions.slice(-10); }

/**
 * Ein autonomer Heil-Takt:
 * 1. Villen mit >= 2 fehlgeschlagenen Aufgaben bekommen einen LLM-
 *    Reparaturplan (Root Cause + Vorbeugung) - automatisch genehmigt,
 *    als hoechstpriorisierte REPARATUR-Aufgaben (max. 1 je Villa/24 h,
 *    damit kein Reparatur-Karussell entsteht).
 * 2. Danach der System-Check: rot heisst "weiter aktiv heilen", gruen
 *    heisst "zurueck zur Ueberwachung".
 */
export async function healTick({ maxRepairs = 2 } = {}) {
  healMemoryContents();
  lastAudit = null;
  const actions = [];
  const hot = db.prepare(
    "SELECT villa_id, COUNT(*) c FROM tasks WHERE status = 'FAILED' AND villa_id IN (SELECT id FROM villas WHERE status != 'ARCHIVED') AND updated_at > ? GROUP BY villa_id HAVING c >= 2"
  ).all(now() - DAY);
  for (const h of hot) {
    if (actions.length >= maxRepairs) break;
    const already = db.prepare(
      "SELECT COUNT(*) c FROM villa_proposals WHERE villa_id = ? AND kind = 'REPAIR' AND created_at > ?"
    ).get(h.villa_id, now() - DAY).c;
    if (already > 0) continue;
    try {
      const r = await proposeForVilla(h.villa_id, 'REPAIR');
      if (!r.created) { actions.push({ villaId: h.villa_id, kind: 'REPAIR', result: 'Vorschlag wartet bereits' }); continue; }
      // Vollautonomie: der Administrator hat die automatische Loesung
      // angeordnet - der Reparaturplan wird sofort zu Aufgaben.
      if (r.fallback) {
        // Standardplan (Offline): anlegen, aber nicht automatisch losrennen
        // lassen? Nein - auch dann heilen, damit kein Stillstand entsteht.
      }
      const ap = approveVillaProposal(r.id);
      actions.push({ villaId: h.villa_id, kind: 'REPAIR', proposalId: r.id, added: ap.added, ts: now() });
    } catch (e) {
      actions.push({ villaId: h.villa_id, kind: 'REPAIR', error: String(e.message || e).slice(0, 160), ts: now() });
    }
  }
  lastActions = [...lastActions, ...actions].slice(-30);
  const audit = systemAudit();
  return { actions, audit };
}
