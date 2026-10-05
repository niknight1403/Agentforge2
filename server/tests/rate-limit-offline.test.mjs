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
    assert.ok(span1 > 35_000 && span1 <= 50_000, `429-Cooldown sollte ~45 s sein, war ${span1} ms`);

    // Zweiter 429 in derCooldown-Fenster darf NICHT eskalieren (frueher 60 s * 2).
    const out2 = await chat([{ role: 'user', content: 'Nochmal' }], { mode: 'chat' });
    assert.equal(out2.offline, true);
    row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
    assert.equal(row.fail, 2, 'Zweiter Fehler nicht gezaehlt');
    const span2 = Number(row.cooldown_until) - now();
    assert.ok(span2 <= 50_000, `429 darf nicht eskalieren: ${span2} ms`);
  } finally {
    srv.close();
  }
});

test('chat: gpt-oss Tool-400 bekommt einen sofortigen Einzelretry', async () => {
  // Groqs gpt-oss ruft stochastisch ein internes Tool auf; Groq antwortet mit
  // 400 "Tool choice is none, but model called a tool". Ein zweiter Versuch
  // derselben Route loest es: kein Cooldown, kein Failover, kein Fehlerzaehler.
  let calls = 0;
  const srv = createServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Tool choice is none, but model called a tool' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: 'Jetzt klappt es' } }], usage: {} }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    onlyGroq(`${base}/v1`);
    const out = await chat([{ role: 'user', content: 'Hallo' }], { mode: 'chat' });
    assert.equal(out.offline, undefined, 'Retry sollte Erfolg bringen, kein Offline');
    assert.equal(out.content, 'Jetzt klappt es');
    assert.equal(calls, 2, 'Genau zwei Anfragen erwartet (Erstversuch + Einzelretry)');
    const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
    assert.equal(row.fail, 0, 'Der Tool-400 darf nicht als Routenfehler zaehlen');
    assert.equal(row.ok, 1, 'Erfolg wird gezaehlt');
    assert.ok(!row.cooldown_until || Number(row.cooldown_until) <= now(), 'Kein Cooldown nach Einzelretry');
  } finally {
    srv.close();
  }
});

test('chat: wiederholter Tool-400 failt normal (Retry nur einmal)', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Tool choice is none, but model called a tool' } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    onlyGroq(`${base}/v1`);
    const out = await chat([{ role: 'user', content: 'Hallo' }], { mode: 'chat' });
    assert.equal(out.offline, true, 'Nach erneutem Tool-400 bleibt Offline-Fallback');
    const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
    assert.equal(row.fail, 1, 'Erst nach Wiederholung zaehlt der Fehler');
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
  // Keys vorhanden, aber Route tot: transienter Offline-Fall, kein DONE.
  process.env.VF_RATE_WAIT_MS = '1'; // Warte-Runden im Test abkuerzen
  resetRoutes();
  db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
  setSecret('GROQ_API_KEY', 'test-key');
  db.prepare('UPDATE routes SET base_url = ? WHERE provider = ?').run('http://127.0.0.1:9', 'groq');

  const { villaId } = await createVilla({ name: 'Offline-Villa', idea: 'Ein kleiner Tracker', agentCount: 3 });
  await orchestrate(villaId, { concurrency: 2, maxTasks: 90, adaptive: false });
  delete process.env.VF_RATE_WAIT_MS;

  const tasks = db.prepare('SELECT * FROM tasks WHERE villa_id = ?').all(villaId);
  assert.ok(tasks.length >= 3, 'Keine Aufgaben angelegt');
  for (const t of tasks) {
    assert.equal(t.status, 'FAILED', `Aufgabe "${t.title}" wurde offline als DONE vorgetaeuscht`);
    assert.match(String(t.result), /NICHT erledigt/, 'Offline-Hinweis fehlt im Ergebnis');
  }
  const artifacts = db.prepare("SELECT COUNT(*) c FROM memories WHERE villa_id = ? AND kind = 'ARTIFACT'").get(villaId).c;
  assert.equal(artifacts, 0, 'Offline-Planertext darf nicht als Artefakt gespeichert werden');
});

test('orchestrate: bewusster Offline-Betrieb ohne Keys bleibt DONE', async () => {
  resetRoutes();
  const { villaId } = await createVilla({ name: 'Planer-Villa', idea: 'Ein kleiner Tracker', agentCount: 3 });
  await orchestrate(villaId, { concurrency: 2, maxTasks: 30, adaptive: false });
  const tasks = db.prepare('SELECT * FROM tasks WHERE villa_id = ?').all(villaId);
  assert.ok(tasks.length >= 3);
  for (const t of tasks) {
    assert.equal(t.status, 'DONE', `Aufgabe "${t.title}" sollte im Offline-Betrieb DONE sein`);
    assert.doesNotMatch(String(t.result), /NICHT erledigt/);
  }
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

test('chat: gpt-oss laeuft ohne response_format, andere Modelle mit', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ model: parsed.model, json: !!parsed.response_format });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"final":"ok"}' }, finish_reason: 'stop' }]
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    resetRoutes();
    db.prepare('DELETE FROM secrets').run();
    setSecret('GROQ_API_KEY', 'k');
    db.prepare("UPDATE routes SET base_url = ?, model = 'openai/gpt-oss-120b' WHERE provider = 'groq'").run(`${base}/v1`,);
    db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
    await chat([{ role: 'user', content: 'Hallo' }], { json: true, mode: 'agent' });
    assert.equal(seen.length, 1, 'Mock nicht aufgerufen');
    assert.equal(seen[0].json, false, 'gpt-oss darf KEIN response_format erhalten');
  } finally {
    srv.close();
  }

  const srv2 = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ model: parsed.model, json: !!parsed.response_format });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"final":"ok"}' }, finish_reason: 'stop' }]
      }));
    });
  });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${srv2.address().port}`;
  try {
    resetRoutes();
    db.prepare('DELETE FROM secrets').run();
    setSecret('GROQ_API_KEY', 'k');
    db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
    db.prepare("UPDATE routes SET base_url = ?, model = 'llama-3.3-70b' WHERE provider = 'groq'").run(`${base2}/v1`);
    await chat([{ role: 'user', content: 'Hallo' }], { json: true, mode: 'agent' });
    assert.equal(seen[1].json, true, 'Nicht-gpt-oss sollte response_format behalten');
  } finally {
    srv2.close();
  }
});
