/**
 * Rat der Agenten (v1.11.0, Feature Pack "Superintelligenz-Loop").
 *
 * Die Agenten einer Villa tauschen sich regelmaessig miteinander aus:
 * jeder Teilnehmer teilt seine wichtigste Erkenntnis aus den letzten
 * Aufgaben und macht einen konkreten Verbesserungsvorschlag fuer das
 * Team. Die Ergebnisse werden
 *   1. als Runde in der council-Tabelle dokumentiert,
 *   2. als Erinnerung (kind COUNCIL, importance 8) an ALLE Agenten
 *      zurueckgegeben — damit fliessen die Erkenntnisse in jeden
 *      naechsten Prompt und die Villa optimiert sich kontinuierlich
 *      selbst weiter,
 *   3. als Bericht (kind COUNCIL) in der Villa sichtbar.
 *
 * autoCouncil() ruft der Wartungs-Timer auf: Villen mit einer Runde, die
 * aelter als COUNCIL_INTERVAL_MS ist, bekommen automatisch eine neue.
 */
import { db, now } from './db.mjs';
import { chat as defaultChat } from './llm.mjs';

/** Abstand zwischen zwei automatischen Rat-Runden je Villa (2 Stunden). */
export const COUNCIL_INTERVAL_MS = 2 * 60 * 60 * 1000;

/** Robuste Text-Extraktion: chat() Formate und Mocks in Tests. */
function textOf(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') return String(r.answer ?? r.text ?? r.content ?? '');
  return '';
}

/**
 * Einberufung einer Rat-Runde. chatFn ist injizierbar (Tests), Produktiv
 * nutzt die normale LLM-Kette des Hubs — inklusive Routen-Rotation und
 * Offline-Fallback.
 */
export async function runCouncil(villaId, { chatFn = defaultChat, participants = 3 } = {}) {
  const villa = db.prepare('SELECT id, name, idea FROM villas WHERE id = ?').get(villaId);
  if (!villa) throw new Error('Villa nicht gefunden');
  const agents = db.prepare(
    "SELECT id, name, role FROM agents WHERE villa_id = ? AND status != 'RETIRED' ORDER BY last_active_at DESC LIMIT ?"
  ).all(villaId, Math.max(1, Number(participants) || 3));
  if (agents.length === 0) throw new Error('Keine Agenten fuer den Rat');

  const doneTasks = db.prepare(
    "SELECT title, result FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY updated_at DESC LIMIT 5"
  ).all(villaId);
  const memories = db.prepare(
    'SELECT title, content FROM memories WHERE villa_id = ? ORDER BY importance DESC, id DESC LIMIT 5'
  ).all(villaId);

  const context = [
    `Villa: ${villa.name} — ${villa.idea}`,
    'Kuerzlich abgeschlossene Aufgaben:',
    ...(doneTasks.length
      ? doneTasks.map((t) => `- ${t.title}: ${String(t.result || '').slice(0, 200)}`)
      : ['- (noch keine abgeschlossenen Aufgaben)']),
    'Wichtigste Erinnerungen:',
    ...(memories.length
      ? memories.map((m) => `- ${m.title}: ${String(m.content).slice(0, 200)}`)
      : ['- (noch keine Erinnerungen)'])
  ].join('\n');

  const messages = [];
  const proposals = [];
  for (const agent of agents) {
    const sys = [
      `Du bist ${agent.name} (${agent.role}) im Rat der Agenten der Villa "${villa.name}".`,
      'Der Rat tauscht Erkenntnisse aus, damit sich die Villa und jedes Team-Mitglied stetig verbessert.',
      'Antworte in hoechstens 6 Zeilen und in zwei Teilen:',
      '1) DEINE ERKENNTNIS: die wichtigste Lehre aus deinen letzten Aufgaben.',
      '2) VORSCHLAG: ein konkreter, umsetzbarer Verbesserungsvorschlag fuer das Team.'
    ].join(' ');
    const reply = textOf(await chatFn(
      [{ role: 'system', content: sys }, { role: 'user', content: context }],
      { maxTokens: 280 }
    ));
    messages.push({ agent: agent.name, role: agent.role, text: reply });
    const idx = reply.indexOf('VORSCHLAG:');
    if (idx >= 0) proposals.push({ agent: agent.name, text: reply.slice(idx + 10).trim() });
  }

  const round = db.prepare('SELECT COUNT(*) c FROM council WHERE villa_id = ?').get(villaId).c + 1;
  db.prepare(
    'INSERT INTO council (villa_id, round, participants, messages, proposals, created_at) VALUES (?,?,?,?,?,?)'
  ).run(villaId, round, agents.map((a) => a.name).join(', '), JSON.stringify(messages), JSON.stringify(proposals), now());

  if (proposals.length > 0) {
    const summary = proposals.map((p) => `${p.agent}: ${p.text}`).join('\n');
    db.prepare(
      'INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(villaId, null, 'villa', 'COUNCIL', `Rat der Agenten Runde ${round}`, summary, 8, now());
    db.prepare(
      'INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)'
    ).run(villaId, 'COUNCIL', `Rat der Agenten Runde ${round}`, summary, JSON.stringify(messages), now());
  }

  return { round, agents: agents.map((a) => a.name), proposals: proposals.length };
}

/** Letzte Rat-Runden einer Villa, geparst (messages/proposals als Arrays). */
export function listCouncil(villaId, limit = 10) {
  const rows = db.prepare(
    'SELECT id, villa_id, round, participants, messages, proposals, created_at FROM council WHERE villa_id = ? ORDER BY id DESC LIMIT ?'
  ).all(villaId, Number(limit) || 10);
  return rows.map((r) => {
    let messages = []; let proposals = [];
    try { messages = JSON.parse(r.messages); } catch { /* defekt: leer */ }
    try { proposals = JSON.parse(r.proposals); } catch { /* defekt: leer */ }
    return { ...r, messages, proposals };
  });
}

/**
 * Wartungs-Hook: Villen deren letzte Rat-Runde aelter als 2 Stunden ist
 * bekommen automatisch eine neue Runde (max. 2 pro Tick). Laeuft die Villa
 * gerade, wird sie uebersprungen — der Rat greift in die Pause.
 */
export function autoCouncil({ chatFn, isRunning } = {}) {
  const cutoff = now() - COUNCIL_INTERVAL_MS;
  const rows = db.prepare(`
    SELECT v.id FROM villas v
    LEFT JOIN (SELECT villa_id, MAX(created_at) last_at FROM council GROUP BY villa_id) c ON c.villa_id = v.id
    WHERE v.status != 'CREATED' AND COALESCE(c.last_at, 0) <= ?
    ORDER BY v.id LIMIT 2`).all(cutoff);
  const out = { considered: [], skipped: [] };
  for (const { id } of rows) {
    if (isRunning?.(id)) { out.skipped.push(id); continue; }
    out.considered.push(id);
    runCouncil(id, { chatFn }).then((r) => {
      db.prepare(
        'INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)'
      ).run(now(), id, 0, 'auto_council', JSON.stringify({ round: r.round }), `${r.proposals} Rat-Vorschlaege`, 1);
    }).catch(() => { /* Rat darf Wartung nie stoeren */ });
  }
  return out;
}
