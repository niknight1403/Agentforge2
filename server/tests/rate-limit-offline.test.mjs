import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { db, now } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { chat } from '../llm.mjs';
import { createVilla, orchestrate } from '../agents.mjs';

/** Definierter Zustand: frischer Routen-Katalog, keine Secrets. */
function resetRoutes() {
  db.prepare('DELETE FROM routes').run();
  db.prepare('DELETE FROM secrets').run();
  seedRoutes();
}

function setSecret(name, value) {
  db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(name, value, now());
}

/** Nur die Groq-Route aktiv, auf eine bestimmte URL gebogen. */
function onlyGroq(url) {
  resetRoutes();
  db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
  setSecret('GROQ_API_KEY', 'test-key');
  db.prepare('UPDATE routes SET base_url = ? WHERE provider = ?').run(url, 'groq');
}

test('chat: 429 sperrt die Route nur kurz statt eskaliert', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    onlyGroq(`${base}/v1`);

    const out1 = await chat([{ role: 'user', content: 'Hallo' }], { mode: 'chat' });
    assert.equal(out1.offline, true, 'Erwartet: Offline-Fallback nach 429');
    let row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
    assert.equal(row.fail, 1, 'Fehlerzaehler nicht erhoeht');
    const span1 = Number(row.cooldown_until) - now();
    assert.ok(span1 > 20_000 && span1 <= 35_000, `429-Cooldown sollte ~30 s sein, war ${span1} ms`);

    // Zweiter 429 in derCooldown-Fenster darf NICHT eskalieren (frueher 60 s * 2).
    const out2 = await chat([{ role: 'user', content: 'Nochmal' }], { mode: 'chat' });
    assert.equal(out2.offline, true);
    row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
    assert.equal(row.fail, 2, 'Zweiter Fehler nicht gezaehlt');
    const span2 = Number(row.cooldown_until) - now();
    assert.ok(span2 <= 35_000, `429 darf nicht eskalieren: ${span2} ms`);
  } finally {
    srv.close();
  }
});

test('chat: andere Fehler eskalieren weiterhin (60 s, 120 s, ...)', async () => {
  onlyGroq('http://127.0.0.1:9'); // garantierter toter Port
  await chat([{ role: 'user', content: 'Hallo' }], { mode: 'chat' });
  const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
  const span = Number(row.cooldown_until) - now();
  assert.ok(span > 55_000, `Defekt-Cooldown sollte ~60 s sein, war ${span} ms`);
});

test('orchestrate: Offline-Antworten markieren Aufgaben FAILED statt DONE', async () => {
  // Keine Keys, alle Routen auf tote Ziele: chat() landet im Offline-Planer.
  resetRoutes();
  db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
  setSecret('GROQ_API_KEY', 'test-key');
  db.prepare('UPDATE routes SET base_url = ? WHERE provider = ?').run('http://127.0.0.1:9', 'groq');

  const { villaId } = await createVilla({ name: 'Offline-Villa', idea: 'Ein kleiner Tracker', agentCount: 3 });
  await orchestrate(villaId, { concurrency: 2, maxTasks: 30, adaptive: false });

  const tasks = db.prepare('SELECT * FROM tasks WHERE villa_id = ?').all(villaId);
  assert.ok(tasks.length >= 3, 'Keine Aufgaben angelegt');
  for (const t of tasks) {
    assert.equal(t.status, 'FAILED', `Aufgabe "${t.title}" wurde offline als DONE vorgetaeuscht`);
    assert.match(String(t.result), /NICHT erledigt/, 'Offline-Hinweis fehlt im Ergebnis');
  }
  const artifacts = db.prepare("SELECT COUNT(*) c FROM memories WHERE villa_id = ? AND kind = 'ARTIFACT'").get(villaId).c;
  assert.equal(artifacts, 0, 'Offline-Planertext darf nicht als Artefakt gespeichert werden');
});

test('orchestrate: echte LLM-Antworten markieren Aufgaben weiterhin DONE', async () => {
  // Minimal-OpenAI-kompatibler Mock: antwortet immer mit {"final": "..."}.
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"final":"Erledigt wie besprochen."}' }, finish_reason: 'stop' }]
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    onlyGroq(`${base}/v1`);
    const { villaId } = await createVilla({ name: 'Mock-Villa', idea: 'Ein kleiner Tracker', agentCount: 3 });
    await orchestrate(villaId, { concurrency: 2, maxTasks: 30, adaptive: false });
    const tasks = db.prepare('SELECT * FROM tasks WHERE villa_id = ?').all(villaId);
    assert.ok(tasks.length >= 3);
    for (const t of tasks) {
      assert.equal(t.status, 'DONE', `Aufgabe "${t.title}" sollte DONE sein`);
      assert.doesNotMatch(String(t.result), /NICHT erledigt/);
    }
  } finally {
    srv.close();
  }
});
