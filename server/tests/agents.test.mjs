import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import {
  runTool, runAgent, createVilla, insertAgent, agentCount,
  memoryContext, prettify, guessRole, TOOL_SPECS, setSource, sourceRoot
} from '../agents.mjs';

test('Vollstaendiger Offline-Roundtrip: Villa anlegen, planen, ausfuehren', async () => {
  seedRoutes();
  db.prepare('DELETE FROM secrets').run();
  const created = await createVilla({ name: 'Testvilla', idea: 'Ein WLAN-Geraet konfigurieren', agentCount: 5 });
  assert.ok(created.villaId > 0);
  assert.equal(created.rootId > 0, true);
  assert.ok(created.plan.tasks.length >= 8, 'Plan zu klein');
  assert.equal(agentCount(created.villaId) >= 3, true, 'Agentenpool zu klein');

  const root = db.prepare('SELECT * FROM agents WHERE id = ?').get(created.rootId);
  const res = await runAgent(root, 'Begruesse mich kurz.', { maxSteps: 2, villaId: created.villaId });
  assert.ok(res.answer && res.answer.length > 5, 'keine Antwort');
  assert.equal(res.offline, true, 'muss offline laufen (kein Key)');
  assert.ok(Array.isArray(res.trace) && res.trace.length >= 1);
});

test('prettify: Markdown-Sternchen raus, JSON-Wrapper aufgeloest', () => {
  assert.equal(prettify('**Fett** und normal'), 'Fett und normal');
  assert.equal(prettify('- Punkt A\n* Punkt B'), '• Punkt A\n• Punkt B');
  assert.equal(prettify('{"final":"Hallo Welt"}'), 'Hallo Welt');
  assert.equal(prettify('Zu\n\n\n\nviel Abstand'), 'Zu\n\nviel Abstand');
});

test('guessRole: Schluesselwoerter treffen die richtige Rolle', () => {
  const t = (title, description = '') => ({ title, description });
  assert.equal(guessRole(t('Umsatzmodell pruefen')), 'BUSINESS');
  assert.equal(guessRole(t('Marketing-Funnel bauen')), 'GROWTH');
  assert.equal(guessRole(t('Code implementieren')), 'CODER');
  assert.equal(guessRole(t('Dokumentation schreiben')), 'DOCUMENTER');
  assert.equal(guessRole(t('Unbekanntes Zeug sortieren')), 'WORKER');
});

test('Werkzeuge: memory_write + memory_search + audit', async () => {
  seedRoutes();
  db.prepare('DELETE FROM secrets').run();
  const v = await createVilla({ name: 'MemVilla', idea: 'Gedaechtnis testen', agentCount: 3 });
  const root = db.prepare('SELECT * FROM agents WHERE id = ?').get(v.rootId);
  const ctx = { villaId: v.villaId, agentId: v.rootId };

  const w = await runTool(ctx, 'memory_write', { title: 'Merksatz', content: 'Zwei mal drei macht vier', kind: 'FACT', importance: 9 });
  assert.ok(w.includes('Merksatz'));
  const s = await runTool(ctx, 'memory_search', { query: 'merksatz' });
  assert.ok(s.includes('Zwei mal drei'), 'Suche findet Eintrag nicht');

  const mem = memoryContext(v.villaId, v.rootId);
  assert.ok(mem.includes('Merksatz'), 'memoryContext zeigt Eintrag nicht');

  const bad = await runTool(ctx, 'gibts_nicht', {});
  assert.ok(bad.startsWith('Unbekanntes Werkzeug'));
  const denied = db.prepare('SELECT COUNT(*) c FROM audit WHERE allowed = 0').get().c;
  assert.ok(denied >= 1, 'abgelehnter Aufruf nicht auditiert');
});

test('Werkzeuge: task_create/task_update und agent_spawn mit Obergrenze', async () => {
  seedRoutes();
  db.prepare('DELETE FROM secrets').run();
  const v = await createVilla({ name: 'TaskVilla', idea: 'Aufgaben testen', agentCount: 3 });
  const ctx = { villaId: v.villaId, agentId: v.rootId };

  const out = await runTool(ctx, 'task_create', { title: 'Neu', description: 'd', priority: 2 });
  const id = Number(out.match(/#(\d+)/)[1]);

  await runTool(ctx, 'task_update', { id, status: 'DONE', result: 'erledigt' });
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.equal(row.status, 'DONE');
  assert.equal(row.result, 'erledigt');

  db.prepare('UPDATE villas SET max_agents = 5 WHERE id = ?').run(v.villaId);
  const before = agentCount(v.villaId);
  const spawn = await runTool(ctx, 'agent_spawn', { role: 'CODER', count: 50 });
  const added = Number(spawn.match(/^(\d+)/)[1]);
  assert.ok(before + added <= 5, 'Obergrenze wurde ignoriert');
});

test('Werkzeuge: artifact_write/artifact_list im Workspace', async () => {
  seedRoutes();
  db.prepare('DELETE FROM secrets').run();
  const v = await createVilla({ name: 'ArtVilla', idea: 'Dateien testen', agentCount: 3 });
  const ctx = { villaId: v.villaId, agentId: v.rootId };

  await runTool(ctx, 'artifact_write', { name: 'notiz.txt', content: 'Hallo Villa' });
  const list = await runTool(ctx, 'artifact_list', {});
  assert.ok(list.includes('notiz.txt'), 'Datei fehlt in der Liste');

  // Unsichere Dateinamen werden gesaeubert.
  await runTool(ctx, 'artifact_write', { name: '../boese/pfad.txt', content: 'x' });
  const list2 = await runTool(ctx, 'artifact_list', {});
  assert.ok(!list2.includes('../boese/pfad.txt'), 'Pfad nicht gesaeubert');
});

test('setSource/sourceRoot: Pfad wird absolut und persistiert', async () => {
  seedRoutes();
  db.prepare('DELETE FROM secrets').run();
  const v = await createVilla({ name: 'SrcVilla', idea: 'Quelle testen', agentCount: 3 });
  const abs = setSource(v.villaId, 'beispiel/ordner');
  assert.ok(abs.startsWith('/'), 'Pfad nicht absolut');
  assert.equal(sourceRoot(v.villaId), abs);
  assert.equal(setSource(v.villaId, ''), '');
});

test('TOOL_SPECS: alle Werkzeuge dokumentiert', () => {
  const names = TOOL_SPECS.map((t) => t.name);
  for (const expect of ['memory_write', 'memory_search', 'task_create', 'task_update', 'agent_spawn', 'artifact_write', 'artifact_list', 'project_tree', 'project_search', 'project_read', 'project_run', 'report_write', 'web_fetch']) {
    assert.ok(names.includes(expect), `Werkzeug ${expect} fehlt in den Specs`);
  }
  assert.ok(TOOL_SPECS.every((t) => t.description && t.schema !== undefined));
});

test('insertAgent: Root-Flag und Systemprompt', async () => {
  seedRoutes();
  db.prepare('DELETE FROM secrets').run();
  const v = await createVilla({ name: 'InsVilla', idea: 'Agenten testen', agentCount: 3 });
  const id = insertAgent(v.villaId, 'Spezial-Coder', 'CODER', v.rootId);
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  assert.equal(a.role, 'CODER');
  assert.equal(a.is_root, 0);
  assert.ok(a.system_prompt.includes('CODER'), 'Rollenprompt fehlt');
});
