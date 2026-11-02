import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-pub-rev-')), 'test.db');
process.chdir(mkdtempSync(join(tmpdir(), 'vf-pub-cwd-')));

const dbm = await import('../db.mjs');
const agents = await import('../agents.mjs');
const publishing = await import('../publishing.mjs');

agents._setPlanningChat(async () => ({
  content: JSON.stringify({
    summary: 'Test plan',
    tasks: [{ title: 'Social Media Setup', description: 'Sandbox Postings', role: 'CODER' }]
  })
}));

test('Publishing Sandbox: erzeugt state SANDBOX und speichert in DB', async () => {
  const created = await agents.createVilla({ name: 'Publishing Test Villa', idea: 'Social Sandbox App' });
  const villaId = created.villaId;

  const res = publishing.createPublishPost(villaId, {
    text: 'Neuer Sprint 8 Release live!',
    platforms: ['x', 'linkedin']
  });

  assert.equal(res.ok, true);
  assert.equal(res.sandbox, true);
  assert.ok(res.hint.includes('SANDBOX'));
  assert.equal(res.posts.length, 2);

  const post1 = res.posts.find((p) => p.platform === 'x');
  assert.ok(post1);
  assert.equal(post1.state, 'SANDBOX');
  assert.equal(post1.text, 'Neuer Sprint 8 Release live!');

  const post2 = res.posts.find((p) => p.platform === 'linkedin');
  assert.ok(post2);
  assert.equal(post2.state, 'SANDBOX');

  // Prüfe via Listing
  const list = publishing.listPublishPosts(villaId);
  assert.equal(list.ok, true);
  assert.equal(list.sandbox, true);
  assert.equal(list.posts.length, 2);
  assert.equal(list.posts[0].state, 'SANDBOX');

  // Prüfe direkt in DB Tabelle posts
  const dbRows = dbm.db.prepare('SELECT * FROM posts WHERE villa_id = ?').all(villaId);
  assert.equal(dbRows.length, 2);
  for (const row of dbRows) {
    assert.equal(row.state, 'SANDBOX');
  }
});

test('Revenue-Light: liefert 3 Monetarisierungs-Vorschläge mit price_eur > 0', async () => {
  const created = await agents.createVilla({ name: 'Revenue Test Villa', idea: 'Monetarisierungs-Engine' });
  const villaId = created.villaId;

  const res1 = publishing.getVillaRevenue(villaId);
  assert.equal(res1.ok, true);
  assert.equal(res1.source, 'offline');
  assert.equal(res1.ideas.length, 3);

  for (const idea of res1.ideas) {
    assert.ok(idea.name && idea.name.length > 0);
    assert.ok(typeof idea.price_eur === 'number' && idea.price_eur > 0, `price_eur (${idea.price_eur}) muss > 0 sein`);
    assert.ok(Array.isArray(idea.steps) && idea.steps.length === 3, 'steps muss 3 Schritte enthalten');
    assert.equal(idea.source, 'offline');
  }

  // Erneuter Aufruf liest aus DB Tabelle revenue_ideas
  const res2 = publishing.getVillaRevenue(villaId);
  assert.equal(res2.ok, true);
  assert.equal(res2.ideas.length, 3);
  assert.equal(res2.ideas[0].id, res1.ideas[0].id);

  const dbRows = dbm.db.prepare('SELECT * FROM revenue_ideas WHERE villa_id = ?').all(villaId);
  assert.equal(dbRows.length, 3);
});

test('Fehlerbehandlung: nicht existierende Villa-ID wirft 404', () => {
  assert.throws(() => publishing.createPublishPost(999999, { text: 'Test' }), (err) => err.statusCode === 404);
  assert.throws(() => publishing.listPublishPosts(999999), (err) => err.statusCode === 404);
  assert.throws(() => publishing.getVillaRevenue(999999), (err) => err.statusCode === 404);
});
