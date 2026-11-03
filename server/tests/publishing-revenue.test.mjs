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
  // Unbrauchbare IDs duerfen keinen SQLite-TypeError werfen, sondern sauber 404.
  assert.throws(() => publishing.createPublishPost('abc', { text: 'Test' }), (err) => err.statusCode === 404);
  assert.throws(() => publishing.getVillaRevenue(NaN), (err) => err.statusCode === 404);
});

test('Revenue-Light: Vorschlaege stammen aus der Villen-Idee (kategorisiert)', async () => {
  const kurs = await agents.createVilla({ name: 'Wissens-Schmiede', idea: 'Ein Selbstlern-Kurs mit Videos und Checklisten zum Thema Prompting' });
  const kursId = kurs.villaId;
  const kursIdeas = publishing.getVillaRevenue(kursId).ideas;
  assert.equal(kursIdeas.length, 3);
  assert.ok(
    kursIdeas.some((i) => /Selbstlern-Kurs/i.test(i.name)),
    `Kurs-Idee muss den Selbstlern-Kurs-Vorschlag ausloesen, bekam: ${kursIdeas.map((i) => i.name).join(' | ')}`
  );

  const api = await agents.createVilla({ name: 'Schnittstellen-Hub', idea: 'Eine REST-API und SDK fuer Automatisierung von Backend-Prozessen' });
  const apiIdeas = publishing.getVillaRevenue(api.villaId).ideas;
  assert.ok(
    apiIdeas.some((i) => /API-Zugang/i.test(i.name)),
    `API-Idee muss den Developer-Abo-Vorschlag ausloesen, bekam: ${apiIdeas.map((i) => i.name).join(' | ')}`
  );

  for (const idea of [...kursIdeas, ...apiIdeas]) {
    assert.equal(idea.source, 'offline');
    assert.ok(idea.price_eur > 0);
    assert.equal(idea.steps.length, 3);
  }
});

test('Revenue-Light: geaenderte Idee erzeugt neue Vorschlaege, gleiche Idee bleibt stabil', async () => {
  const created = await agents.createVilla({ name: 'Wandel-Villa', idea: 'Ein Podcast ueber Musikproduktion' });
  const villaId = created.villaId;

  const first = publishing.getVillaRevenue(villaId).ideas;
  assert.ok(first.some((i) => /Mitgliedschaft/i.test(i.name)));

  // Gleiche Idee -> identische Zeilen (kein Neuschreiben)
  const again = publishing.getVillaRevenue(villaId).ideas;
  assert.deepEqual(again.map((i) => i.id), first.map((i) => i.id));

  // Idee aendern -> Vorschlaege werden neu klassifiziert und ersetzt
  dbm.db.prepare('UPDATE villas SET idea = ? WHERE id = ?').run('Bausatz und 3D-Druck-Geraet fuer Robotik-Sensoren', villaId);
  const changed = publishing.getVillaRevenue(villaId).ideas;
  assert.equal(changed.length, 3);
  assert.ok(
    changed.some((i) => /Bausatz/i.test(i.name)),
    `Nach Idee-Wechsel muss der Bausatz-Vorschlag erscheinen, bekam: ${changed.map((i) => i.name).join(' | ')}`
  );
  const rows = dbm.db.prepare('SELECT COUNT(*) c FROM revenue_ideas WHERE villa_id = ?').get(villaId).c;
  assert.equal(rows, 3, 'alte Vorschlaege muessen ersetzt, nicht angehaengt werden');
});

test('Publishing Sandbox: ungueltige Eingaben und Plattform-Normalisierung', async () => {
  const created = await agents.createVilla({ name: 'Eingabe-Villa', idea: 'Test der Validierung' });
  const villaId = created.villaId;

  assert.throws(() => publishing.createPublishPost(villaId, {}), (err) => err.statusCode === 400);
  assert.throws(() => publishing.createPublishPost(villaId, { text: '   ' }), (err) => err.statusCode === 400);

  // Plattformen werden getrimmt/lowercased; ohne Angabe faellt es auf 'x' zurueck.
  const res = publishing.createPublishPost(villaId, { text: 'Hallo Welt', platforms: ['  X  ', 'LinkedIn'] });
  assert.deepEqual(res.posts.map((p) => p.platform), ['x', 'linkedin']);
  assert.ok(res.posts.every((p) => p.state === 'SANDBOX'), 'jeder Post muss state=SANDBOX haben');

  const fallback = publishing.createPublishPost(villaId, { text: 'Ohne Plattform' });
  assert.deepEqual(fallback.posts.map((p) => p.platform), ['x']);
  assert.equal(fallback.sandbox, true);

  // Keine echten API-Aufrufe: Modul exportiert keinen Netzwerk-Pfad und Antwort sagt es klar.
  assert.match(res.hint, /SANDBOX/);
  assert.match(res.hint, /Keine Plattform-Tokens/i);
});
