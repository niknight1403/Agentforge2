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
import { maybeAutoBuild } from './builds.mjs';
import { chat as defaultChat } from './llm.mjs';
import { maturity, proposalsToTasks } from './product.mjs';
import { buildDissent, parseRubric, rubricSystemPrompt, rubricUserPrompt, summarizeScores } from './council-rubric.mjs';

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
  let agents = db.prepare(
    "SELECT id, name, role FROM agents WHERE villa_id = ? AND status != 'RETIRED' ORDER BY last_active_at DESC LIMIT ?"
  ).all(villaId, Math.max(1, Number(participants) || 3));
  // AGI-Sitz: Der Rat bekommt zusaetzlich einen Denker (STRATEGIST/REASONER/
  // SYNTHESIZER/VERIFIER) der Villa, damit jedes Gremium Tiefe und Pruefkraft hat.
  const agi = db.prepare(
    "SELECT id, name, role FROM agents WHERE villa_id = ? AND role IN ('STRATEGIST','REASONER','SYNTHESIZER','VERIFIER') AND status != 'RETIRED' ORDER BY last_active_at DESC LIMIT 1"
  ).get(villaId);
  if (agi && !agents.some((a) => a.id === agi.id)) agents = [...agents, agi];
  if (agents.length === 0) throw new Error('Keine Agenten fuer den Rat');

  const doneTasks = db.prepare(
    "SELECT title, result FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY updated_at DESC LIMIT 5"
  ).all(villaId);
  const memories = db.prepare(
    'SELECT title, content FROM memories WHERE villa_id = ? ORDER BY importance DESC, id DESC LIMIT 5'
  ).all(villaId);

  const mat = maturity(villaId);
  const phase = mat.phases.find((p) => p.id === mat.currentPhase);
  const context = [
    `Villa: ${villa.name} — ${villa.idea}`,
    `Marktreife: ${mat.score}/100 (${mat.stage}). Aktuelle Phase: ${phase?.title} — Ziel: ${phase?.goal}`,
    'Offene Pflichten der Phase: ' + (phase?.items.filter((i) => i.state !== 'DONE').map((i) => i.title).join('; ') || 'keine'),
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
      '2) VORSCHLAG: ein konkreter, umsetzbarer Schritt, der das Produkt der Marktreife naeher bringt (naechste Phase beachten).'
    ].join(' ');
    const reply = textOf(await chatFn(
      [{ role: 'system', content: sys }, { role: 'user', content: context }],
      { maxTokens: 420 }
    ));
    messages.push({ agent: agent.name, role: agent.role, text: reply });
    const idx = reply.indexOf('VORSCHLAG:');
    if (idx >= 0) proposals.push({ agent: agent.name, text: reply.slice(idx + 10).trim() });
  }

  // Bewertungs-Synthese: ein Denker-Durchlauf bewertet jeden Vorschlag nach
  // Wirkung (impact 1-10), Aufwand (effort 1-10) und der Rubrik des Rats
  // (Nutzen, Machbarkeit, Belegbarkeit, Differenzierung — je 1-5).
  // Faellt die Bewertung aus, wird NICHTS erfunden: die Vorschlaege laufen als
  // `rated: false` weiter und landen als offene Minderheitenvoten im Datensatz.
  let ranked = proposals.map((p) => ({ ...p, impact: null, effort: null, score: null, rated: false }));
  let rubric = { rated: false, entries: [], reason: 'keine Vorschlaege' };
  if (proposals.length > 0) {
    try {
      const raw = textOf(await chatFn([
        { role: 'system', content: rubricSystemPrompt() },
        { role: 'user', content: rubricUserPrompt(proposals) }
      ], { maxTokens: 520, json: true }));
      rubric = parseRubric(raw, proposals);
    } catch (error) {
      rubric = { rated: false, entries: [], reason: `Bewertung nicht auswertbar: ${String(error?.message || error).slice(0, 120)}` };
    }
    if (rubric.entries.length) {
      // Zuordnung primaer ueber den Agentennamen (Reihenfolge im Modell-Output
      // ist nicht verlaesslich), nur als Rueckfall ueber den Index.
      ranked = proposals.map((p, i) => {
        const byName = rubric.entries.find((e) => e.agent && p.agent && e.agent === p.agent);
        const entry = byName || rubric.entries[i] || {};
        return {
          ...p,
          impact: entry.impact ?? null,
          effort: entry.effort ?? null,
          score: entry.leverage ?? null,
          rubric: entry.rubric ?? null,
          weighted: entry.weighted ?? null,
          rated: Boolean(entry.rated),
        };
      }).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    }
  }

  const round = db.prepare('SELECT COUNT(*) c FROM council WHERE villa_id = ?').get(villaId).c + 1;
  // Aufgaben-Auswahl: nur bewertete Vorschlaege mit echtem Hebel. Ist keine
  // Bewertung vorhanden, wird ehrlich der erste Vorschlag genommen (damit die
  // Villa nicht stillsteht) und das im Datensatz als `unrated` markiert.
  const actionable = ranked.filter((r) => r.rated && Number(r.score) >= 6);
  const chosen = actionable.length ? actionable : ranked.slice(0, 1);
  // Ohne Bewertung gibt es trotzdem Voten: jeder nicht uebernommene Vorschlag
  // bleibt als offener Vorschlag im Datensatz, klar als unbewertet markiert.
  const dissentEntries = rubric.entries.length
    ? rubric.entries
    : ranked.map((r) => ({ agent: r.agent, rubric: {}, rated: false, missing: ['keine Bewertung vorhanden'], leverage: null }));
  const dissent = buildDissent(dissentEntries, { selectedAgents: chosen.map((c) => c.agent), threshold: 6 });

  db.prepare(
    'INSERT INTO council (villa_id, round, participants, messages, proposals, scores, dissent, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    villaId,
    round,
    agents.map((a) => a.name).join(', '),
    JSON.stringify(messages),
    JSON.stringify(ranked),
    JSON.stringify(summarizeScores(rubric)),
    JSON.stringify(dissent),
    now()
  );

  if (proposals.length > 0) {
    const summary = proposals.map((p) => `${p.agent}: ${p.text}`).join('\n');
    db.prepare(
      'INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(villaId, null, 'villa', 'COUNCIL', `Rat der Agenten Runde ${round}`, summary, 8, now());
    db.prepare(
      'INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)'
    ).run(villaId, 'COUNCIL', `Rat der Agenten Runde ${round}`, summary, JSON.stringify(messages), now());
  }

  const tasksCreated = proposalsToTasks(villaId, chosen);
  return {
    round,
    agents: agents.map((a) => a.name),
    proposals: proposals.length,
    ranked: ranked.map((r) => ({
      agent: r.agent,
      impact: r.impact,
      effort: r.effort,
      score: r.score,
      weighted: r.weighted ?? null,
      rated: r.rated,
    })),
    rating: { rated: rubric.rated, reason: rubric.reason ?? null },
    dissent,
    tasksCreated,
    maturity: mat.score,
    phase: mat.currentPhase,
  };
}

/** Letzte Rat-Runden einer Villa, geparst (messages/proposals als Arrays). */
export function listCouncil(villaId, limit = 10) {
  const rows = db.prepare(
    'SELECT id, villa_id, round, participants, messages, proposals, scores, dissent, created_at FROM council WHERE villa_id = ? ORDER BY id DESC LIMIT ?'
  ).all(villaId, Number(limit) || 10);
  return rows.map((r) => {
    let messages = []; let proposals = []; let scores = {}; let dissent = [];
    try { messages = JSON.parse(r.messages); } catch { /* defekt: leer */ }
    try { proposals = JSON.parse(r.proposals); } catch { /* defekt: leer */ }
    try { scores = JSON.parse(r.scores); } catch { /* defekt: unbewertet */ }
    try { dissent = JSON.parse(r.dissent); } catch { /* defekt: keine Voten */ }
    return { ...r, messages, proposals, scores, dissent };
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
    // Autonome Produkt-Bereitstellung: ab Beta-Reife einmalig ein Paket bauen.
    try { if (maybeAutoBuild(id)) out.autoBuild = [...(out.autoBuild || []), id]; } catch { /* Build stoert den Rat nie */ }
    runCouncil(id, { chatFn }).then((r) => {
      db.prepare(
        'INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)'
      ).run(now(), id, 0, 'auto_council', JSON.stringify({ round: r.round }), `${r.proposals} Rat-Vorschlaege`, 1);
    }).catch(() => { /* Rat darf Wartung nie stoeren */ });
  }
  return out;
}
