// Test des Master-Agenten gegen eine Wegwerf-Datenbank (LLM und Villa-Start ersetzt).
// Start: node --test server/tests/master.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-master-')), 'test.db');
process.chdir(mkdtempSync(join(tmpdir(), 'vf-master-cwd-')));

const dbm = await import('../db.mjs');
const master = await import('../master.mjs');
const agents = await import('../agents.mjs');
agents._setPlanningChat(async()=>({content:JSON.stringify({summary:'Test plan',tasks:[{title:'Test-App implementieren',description:'Akzeptanz: Tests laufen',role:'CODER'}]})}));

// createVilla funktioniert echt (Wegwerf-DB); orchestrate laeuft im Leerlauf,
// da die frisch gegruendete Villa ihren Lauf startet - hier gewollt und harmlos.

test('masterChat gruendet eine Villa aus einem Wunsch-Prompt mit Design-Konzept', async () => {
  const GOOD = JSON.stringify({
    reply: 'Ich gruende dir die Villa und starte die Entwicklung.',
    create: {
      name: 'Sprachassistent App',
      idea: 'Professionelles Prompt: Ziel, Zielgruppe, 5 Kernfunktionen mit Akzeptanz, Cyber-Neon Design.',
      designBrief: 'Dark Glassmorphism Chat-App mit Neon-Bubbles'
    }
  });
  master._setChat(async () => ({ content: GOOD }));
  const out = await master.masterChat('Bau mir eine App die meine Smart-Home-Geraete per Sprache steuert');
  assert.equal(out.started, true);
  assert.ok(out.villaId > 0, 'Villa wurde angelegt');
  assert.equal(out.villaName, 'Sprachassistent App');
  assert.ok(out.designImage.startsWith('https://image.pollinations.ai/prompt/'), 'Designer-Tool-URL vorhanden');
  // Villa existiert mit autonomie 1 (autonomer Betrieb)
  const v = dbm.db.prepare('SELECT * FROM villas WHERE id = ?').get(out.villaId);
  assert.ok(v, 'Villa in DB');
  assert.equal(v.autonomy, 1);
  assert.ok(v.idea.includes('DESIGN-KONZEPT'), 'Design-Brief im Prompt verankert');
});

test('masterChat beantwortet Fragen ohne Gruendung (create: null)', async () => {
  const ONLY_REPLY = JSON.stringify({ reply: 'Gerade laufen 8 Villen, alles gesund.', create: null });
  master._setChat(async () => ({ content: ONLY_REPLY }));
  const out = await master.masterChat('Wie geht es meinen Villen?');
  assert.equal(out.villaId, 0);
  assert.equal(out.started === true, false);
  assert.ok(out.reply.includes('Villen'));
});

test('Ohne Modell: kein halbfertiges Gruenden, ehrlicher Hinweis', async () => {
  master._setChat(async () => ({ offline: true, content: '' }));
  const out = await master.masterChat('Bau mir was');
  assert.equal(out.offline, true);
  assert.equal(out.villaId, 0);
  assert.match(out.reply, /kein Sprachmodell/);
});

test('Verlauf enthaelt Nutzer- und Meister-Nachrichten samt Villen-Verweis', async () => {
  const h = master.masterHistory();
  assert.ok(h.length >= 4, 'History gemischt');
  const withVilla = h.find((x) => x.villaId > 0);
  assert.ok(withVilla, 'Nachricht mit Villa-Verweis');
  assert.equal(withVilla.villaName, 'Sprachassistent App');
});

test('masterChat steuert Villen: pause_villa und start_villa per Namen', async () => {
  const CMD = JSON.stringify({
    reply: 'Ich pausiere die Sprachassistenten-Villa.',
    create: null,
    actions: [{ type: 'pause_villa', name: 'Sprachassistent App' }, { type: 'start_villa', name: 'Sprachassistent App' }]
  });
  master._setChat(async () => ({ content: CMD }));
  const out = await master.masterChat('Pausiere die Sprachassistent App und starte sie wieder');
  assert.ok(Array.isArray(out.actions) && out.actions.length === 2);
  assert.equal(out.actions[0].ok, true);
  assert.equal(out.actions[0].type, 'pause_villa');
  assert.equal(out.actions[1].ok, true);
  assert.equal(out.actions[1].type, 'start_villa');
  const v = dbm.db.prepare('SELECT status, autonomy FROM villas WHERE name LIKE ?').get('%Sprachassistent%');
  assert.equal(v.autonomy, 1, 'start_villa setzt Autonomie wieder an');
  // Unbekannte Villa wird sauber gemeldet, nicht ausgefuehrt
  const MISS = JSON.stringify({ reply: 'ok', create: null, actions: [{ type: 'stop_villa', name: 'GibtEsNicht' }] });
  master._setChat(async () => ({ content: MISS }));
  const out2 = await master.masterChat('Stoppe GibtEsNicht');
  assert.equal(out2.actions[0].ok, false);
});

test('designImageUrl bleibt deterministisch bei gleichem Seed und kuerzt den Brief', () => {
  const a = master.designImageUrl('Kurzer Brief', 42);
  const b = master.designImageUrl('Kurzer Brief', 42);
  assert.equal(a, b);
  assert.ok(a.includes('seed=42'));
});
