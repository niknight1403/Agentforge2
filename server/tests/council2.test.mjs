/**
 * Sprint 5 (v1.36.0) — Rats-Upgrade.
 *
 * 1. AGI-Sitz: Jede Rat-Runde bekommt zusaetzlich einen Denker der Villa
 *    (STRATEGIST/REASONER/SYNTHESIZER/VERIFIER) in das Gremium.
 * 2. Bewertungs-Synthese: Vorschlaege kriegen impact/effort (1-10) und einen
 *    Hebel-Score; nur wirkungsvolle Vorschlaege werden Aufgaben.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'rat-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const { runCouncil, listCouncil } = await import('../council.mjs');
const { insertAgent } = await import('../agents.mjs');

function seedVilla(name) {
  const t = now();
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?, 'Eine Idee mit etwas Laenge fuer den Rat','CREATED',100,1,?,?)").run(name, t, t);
  return Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
}

const agentReply = (name, text) => ({ answer: `ERKENNTNIS: Lehre von ${name}.\nVORSCHLAG: ${text}` });

test('Bewertungs-Synthese ordnet Vorschlaege und nur Hebel >= 6 wird Aufgabe', async () => {
  const villaId = seedVilla('Bewertungs-Villa');
  insertAgent(villaId, 'Arbeiter-1', 'CODER');
  insertAgent(villaId, 'Arbeiter-2', 'WORKER');
  const thinker = insertAgent(villaId, 'Denker-1', 'VERIFIER');
  // Zeitstempel pinnen: Arbeiter sind die aktiven Teilnehmer, der Denker
  // kommt ausschliesslich ueber den AGI-Sitz dazu (kein Timestamp-Zufall).
  db.prepare('UPDATE agents SET last_active_at = ? WHERE villa_id = ? AND role != ?').run(now() + 10_000, villaId, 'VERIFIER');
  db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(now() - 10_000, thinker);

  const calls = [];
  const r = await runCouncil(villaId, {
    participants: 2,
    chatFn: async (msgs, opts) => {
      calls.push({ msgs, opts });
      if (msgs[0].content.includes('Bewertungs-Synthese')) {
        return { content: JSON.stringify({ ranked: [
          { agent: 'Arbeiter-1', impact: 8, effort: 2 },
          { agent: 'Arbeiter-2', impact: 3, effort: 6 },
          { agent: 'Denker-1', impact: 5, effort: 5 }
        ] }) };
      }
      const sys = msgs[0].content;
      const who = sys.includes('Arbeiter-1') ? 'Arbeiter-1' : sys.includes('Arbeiter-2') ? 'Arbeiter-2' : 'Denker-1';
      const text = who === 'Arbeiter-1'
        ? 'Zahlungsabfluss-Auswertung als Dashboard mit vier Kennzahlen umsetzen'
        : who === 'Arbeiter-2'
          ? 'Farben der Oberflaeche saisonal anpassen und Umbenennung testen'
          : 'Rahmenbedingungen fuer Zahlungen gegen echte Nutzung pruefen und dokumentieren';
      return agentReply(who, text);
    }
  });
  assert.ok(calls.some((c) => c.msgs[0].content.includes('Bewertungs-Synthese')), 'Synthese-Lauf fehlt');
  assert.equal(r.ranked.length, 3);
  const scores = r.ranked.map((x) => x.score);
  assert.ok(scores[0] >= scores[scores.length - 1], 'Ranking absteigend');
  assert.equal(r.tasksCreated, 1, 'nur der wirkungsvolle Vorschlag wird Aufgabe');

  const stored = listCouncil(villaId, 1)[0];
  assert.ok(stored.proposals[0].score !== undefined, 'Score persistiert');
  assert.ok(stored.messages.length === 3, 'AGI-Sitz teilgenommen');
});

test('Defekte Synthese erfindet keine Scores, der Rat bleibt trotzdem handlungsfhig', async () => {
  const villaId = seedVilla('Fallback-Villa');
  insertAgent(villaId, 'Arbeiter-A', 'CODER');
  const r = await runCouncil(villaId, {
    participants: 1,
    chatFn: async (msgs) => {
      if (msgs[0].content.includes('Bewertungs-Synthese')) return { content: 'völlig kaputt{' };
      return agentReply('Arbeiter-A', 'Automatische Backups aller Villen-Datenbanken naechtlich testen und dokumentieren');
    }
  });
  assert.equal(r.proposals, 1);
  // Ehrlichkeit statt Scheinpraezision: ohne auswertbare Bewertung bleibt der
  // Vorschlag unbewertet (score null, rated false) - und wird als offenes
  // Votum dokumentiert. Aufgabe entsteht trotzdem, damit die Villa laeuft.
  assert.equal(r.rating.rated, false);
  assert.ok(r.ranked.every((x) => x.score === null && x.rated === false));
  assert.equal(r.tasksCreated >= 1, true);
});

test('AGI-Sitz: Denker-Rolle nimmt auch ausserhalb der Teilnehmerzahl teil', async () => {
  const villaId = seedVilla('Denker-Villa');
  const workerId = insertAgent(villaId, 'Aktiver-Arbeiter', 'WORKER');
  insertAgent(villaId, 'Denker-R', 'REASONER');
  // Arbeiter war kuerzlich aktiv: er belegt den Teilnehmerplatz, der Denker
  // muss daher ueber den AGI-Sitz dazukommen.
  db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(now() + 10_000, workerId);
  db.prepare('UPDATE agents SET last_active_at = ? WHERE villa_id = ? AND role = ?').run(now() - 10_000, villaId, 'REASONER');
  const seen = [];
  const r = await runCouncil(villaId, {
    participants: 1,
    chatFn: async (msgs) => {
      const sys = msgs[0].content;
      seen.push(sys.match(/Du bist (\S+) \(/)?.[1]);
      return agentReply('x', 'Onboarding-Checkliste mit fuenf konkreten Schritten fuer neue Nutzer aufbauen und testen');
    }
  });
  assert.ok(seen.some((n) => n === 'Denker-R'), 'Denker saass im Rat');
  assert.equal(r.agents.length, 2);
});
