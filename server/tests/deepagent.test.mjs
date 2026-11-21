import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.mjs';
import { createUser } from '../auth.mjs';
import { TMP } from './_env.mjs';

process.env.DEEP_DIR = join(TMP, 'deep-files');
const { createDeepProject, deepChat, addDeepFile, deepPreviewFile, deleteDeepProject, listDeepProjects, deepProjectDetail, deepProjectDevelopmentStatus, linkDeepProjectVilla, runDeepProjectDevelopmentOnce, isDeepProjectDeveloping, waitForInitialPlan, prepareDeepProjectHandover, isInitialPlanPending } = await import('../deepagent.mjs');
const { insertVillaRecord, selectSequentialTaskBatch } = await import('../agents.mjs');
const reply = async () => ({ content: 'Bauplan: MVP, Tests und Startanleitung.' });

test('DeepAgent öffnet den Projektchat sofort und erzeugt den initialen Plan im Hintergrund', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const project = await createDeepProject('Eine App mit sofortigem Entwicklungsworkspace', {
    deferInitialPlan: true,
    chatFn: async () => { await gate; return reply(); }
  });
  assert.equal(project.initialPending, true);
  assert.equal(isInitialPlanPending(project.id), true);
  assert.match(deepProjectDetail(project.id).messages[0].content, /analysiere deine Idee/i);
  let handoverSettled = false;
  const handoverPromise = prepareDeepProjectHandover(project.id).then((result) => {
    handoverSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handoverSettled, false, 'Villa handoff must wait while the initial plan is still running');
  release();
  const handover = await handoverPromise;
  assert.equal(handover.ok, true);
  assert.match(handover.idea, /Bauplan: MVP/);
  assert.doesNotMatch(handover.idea, /analysiere deine Idee/i);
  const planResult = await waitForInitialPlan(project.id);
  assert.equal(planResult.offline, false);
  assert.equal(isInitialPlanPending(project.id), false);
  const messages = deepProjectDetail(project.id).messages;
  assert.ok(messages.some((message) => /Bauplan: MVP/.test(message.content)));
  assert.ok(!messages.some((message) => /analysiere deine Idee/i.test(message.content)));
});

test('DeepAgent deletion cancels a pending plan without recreating orphan messages', async () => {
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const project = await createDeepProject('Ein Projekt das waehrend der ersten Analyse geloescht wird', {
    deferInitialPlan: true,
    chatFn: async () => {
      started();
      await gate;
      return reply();
    }
  });
  await didStart;
  assert.equal(isInitialPlanPending(project.id), true);
  assert.equal(deleteDeepProject(project.id), true);
  assert.equal(isInitialPlanPending(project.id), false);
  release();
  await waitForInitialPlan(project.id);
  assert.equal(deepProjectDetail(project.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deep_messages WHERE project_id=?').get(project.id).count, 0);
});

test('DeepAgent meldet einen Offline-Initialplan getrennt von einem fertigen Plan', async () => {
  const unavailable = Object.assign(new Error('Keine Route erreichbar'), { code: 'LLM_UNAVAILABLE' });
  const project = await createDeepProject('Eine App mit einem offline nicht verfügbaren Sprachmodell', {
    deferInitialPlan: true,
    chatFn: async () => { throw unavailable; }
  });
  const result = await waitForInitialPlan(project.id);
  assert.equal(result.offline, true);
  assert.match(result.reply, /kein Sprachmodell erreichbar/i);
  const handover = await prepareDeepProjectHandover(project.id);
  assert.equal(handover.ok, false);
  assert.equal(handover.code, 'INITIAL_PLAN_UNAVAILABLE');
  assert.equal(isInitialPlanPending(project.id), false);
});


test('Deep Agent übergibt lesbare Textanhänge mit klarer Datenabgrenzung', async () => {
  const project = await createDeepProject('Eine App für professionelle Projektplanung', { chatFn: reply });
  const file = addDeepFile(project.id, 'anforderungen.md', 'text/markdown', Buffer.from('# Abnahmekriterien\nNutzer kann Projekte exportieren.').toString('base64'));
  let sent;
  await deepChat(project.id, 'Prüfe meine Anforderungen.', [{ kind: 'file', fileId: file.id }], {
    chatFn: async (messages) => { sent = messages; return reply(); }
  });
  const prompt = sent.at(-1).content;
  assert.match(prompt, /Nutzer kann Projekte exportieren/);
  assert.match(prompt, /als Nutzerdaten behandeln/);
});

test('Deep Agent behauptet bei Bildanhängen keine ungesehene Analyse', async () => {
  const project = await createDeepProject('Eine App für professionelle Projektplanung', { chatFn: reply });
  const file = addDeepFile(project.id, 'screenshot.png', 'image/png', Buffer.from('image-bytes').toString('base64'));
  let sent;
  await deepChat(project.id, 'Was zeigt der Screenshot?', [{ kind: 'file', fileId: file.id }], {
    chatFn: async (messages) => { sent = messages; return reply(); }
  });
  assert.match(sent.at(-1).content, /nicht direkt auswertbar/);
  assert.match(sent[0].content, /Behaupte keine Bild-\/Videoanalyse/);
});

test('Deep Agent sichert Nachrichten bei echtem LLM-Ausfall und antwortet ehrlich', async () => {
  const project = await createDeepProject('Eine App für professionelle Projektplanung', { chatFn: reply });
  const unavailable = Object.assign(new Error('Keine Route erreichbar'), { code: 'LLM_UNAVAILABLE' });
  const result = await deepChat(project.id, 'Baue jetzt den Export.', [], { chatFn: async () => { throw unavailable; } });
  assert.equal(result.offline, true);
  assert.match(result.reply, /kein Sprachmodell erreichbar/i);
});

test('DeepAgent-Experte erhält einen produktionsorientierten Entwicklungsvertrag', async () => {
  const project = await createDeepProject('Eine professionelle Bildbearbeitungs-App', {
    chatFn: async (messages) => {
      assert.match(messages[0].content, /Principal Engineer/);
      assert.match(messages[0].content, /Builds, APKs und Medienrendering/);
      assert.match(messages[0].content, /Keine Platzhalter/);
      return reply();
    }
  });
  assert.ok(project.id > 0);
});

test('Deep-Projekt lässt sich einzeln samt Dateien löschen, während andere Projekte erhalten bleiben', async () => {
  const first = await createDeepProject('Projekt zum Löschen mit Datei', { chatFn: reply });
  const second = await createDeepProject('Projekt das erhalten bleiben soll', { chatFn: reply });
  const uploaded = addDeepFile(first.id, 'notiz.txt', 'text/plain', Buffer.from('Projektdatei').toString('base64'));
  assert.ok(deepProjectDetail(first.id).messages.length > 0);
  assert.equal(deleteDeepProject(first.id), true);
  assert.equal(deleteDeepProject(first.id), false);
  assert.equal(deepProjectDetail(first.id), null);
  assert.ok(listDeepProjects().some((project) => project.id === second.id));
  assert.equal(existsSync(join(TMP, 'deep-files', String(first.id))), false);
  assert.ok(uploaded.id > 0);
});

test('Deep-Projekt merkt die zugehörige ausführbare Villa und liefert sie in Liste und Detail', async () => {
  const project = await createDeepProject('Eine App mit einer ausführbaren Build-Pipeline', { chatFn: reply });
  assert.equal(linkDeepProjectVilla(project.id, 42), 42);
  assert.equal(linkDeepProjectVilla(project.id, 43), 43);
  assert.equal(deepProjectDetail(project.id).project.villa_id, 43);
  assert.equal(listDeepProjects().find((item) => item.id === project.id).villa_id, 43);
});

test('Parallele Deep-Projekt-Übergaben teilen denselben Entwicklungsauftrag', async () => {
  let count = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runDeepProjectDevelopmentOnce(7001, async () => {
    count += 1;
    await gate;
    return { villaId: 99 };
  });
  const second = runDeepProjectDevelopmentOnce(7001, async () => {
    count += 1;
    return { villaId: 100 };
  });
  assert.equal(isDeepProjectDeveloping(7001), true);
  release();
  assert.deepEqual(await first, { villaId: 99 });
  assert.deepEqual(await second, { villaId: 99 });
  assert.equal(count, 1);
  assert.equal(isDeepProjectDeveloping(7001), false);
});


test('Deep-Projekt-Vorschau lehnt FIFOs ohne blockierenden Lesezugriff ab', async (t) => {
  if (process.platform === 'win32') return t.skip('mkfifo ist auf Windows nicht verfügbar');
  const project = await createDeepProject('Eine Web-App mit sicherer Vorschau', {chatFn: reply});
  const dist = join(TMP, 'deep-files', String(project.id), 'dist');
  mkdirSync(dist, {recursive: true});
  const fifo = join(dist, 'blocked.pipe');
  try { execFileSync('mkfifo', [fifo]); }
  catch { return t.skip('mkfifo ist auf diesem Runner nicht verfügbar'); }
  const started = Date.now();
  assert.equal(deepPreviewFile(project.id, 'dist/blocked.pipe'), null);
  assert.ok(Date.now() - started < 1000, 'opening a FIFO must not block the Hub event loop');
});

test('Deep-Projekt-Vorschau erlaubt nur Dateien aus freigegebenen Build-Verzeichnissen', async () => {
  const project = await createDeepProject('Eine Web-App mit Live-Vorschau und Dashboard', { chatFn: reply });
  const dist = join(TMP, 'deep-files', String(project.id), 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Preview</title>');
  writeFileSync(join(dist, 'app.js'), 'console.log("preview")');
  const projectRoot = join(TMP, 'deep-files', String(project.id));
  writeFileSync(join(projectRoot, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>');
  const rootEntry = deepPreviewFile(project.id, 'index.html');
  assert.equal(rootEntry.mime, 'text/html; charset=utf-8', 'only the explicit root entry point is served');
  closeSync(rootEntry.fd);
  const rootAssets = join(projectRoot, 'assets');
  mkdirSync(rootAssets, { recursive: true });
  writeFileSync(join(rootAssets, 'app.js'), 'console.log("root preview asset")');
  const rootAsset = deepPreviewFile(project.id, 'assets/app.js');
  assert.equal(rootAsset.mime, 'text/javascript; charset=utf-8',
    'only conventional root asset directories are exposed for a root index.html');
  closeSync(rootAsset.fd);
  assert.equal(deepPreviewFile(project.id, 'server/secrets.json'), null, 'arbitrary project-root files remain private');
  const outside = join(TMP, 'outside-secret.txt');
  writeFileSync(outside, 'must not be served');
  symlinkSync(outside, join(dist, 'leak.txt'));
  const htmlEntry = deepPreviewFile(project.id, 'dist/index.html');
  assert.equal(htmlEntry.mime, 'text/html; charset=utf-8');
  closeSync(htmlEntry.fd);
  const appEntry = deepPreviewFile(project.id, 'dist/app.js');
  assert.equal(appEntry.mime, 'text/javascript; charset=utf-8');
  closeSync(appEntry.fd);
  const pinned = deepPreviewFile(project.id, 'dist/app.js');
  assert.ok(Number.isInteger(pinned.fd), 'preview returns an already-open file descriptor');
  const original = join(dist, 'app-original.js');
  renameSync(join(dist, 'app.js'), original);
  symlinkSync(outside, join(dist, 'app.js'));
  try {
    assert.equal(readFileSync(pinned.fd, 'utf8'), 'console.log("preview")',
      'replacing the checked path cannot redirect the already-open descriptor');
  } finally { closeSync(pinned.fd); }
  assert.equal(deepPreviewFile(project.id, 'dist/../../../../etc/passwd'), null);
  assert.equal(deepPreviewFile(project.id, '.env'), null);
  assert.equal(deepPreviewFile(project.id, 'dist/leak.txt'), null);
});


test('DeepAgent can recover from an offline initial plan after a successful chat', async () => {
  const unavailable = Object.assign(new Error('Keine Route erreichbar'), {code: 'LLM_UNAVAILABLE'});
  const project = await createDeepProject('Eine App, deren erster Plan zunächst offline ist', {
    deferInitialPlan: true,
    chatFn: async () => { throw unavailable; }
  });
  assert.equal((await waitForInitialPlan(project.id)).offline, true);
  const recovery = await deepChat(project.id, 'Erstelle jetzt den konkreten Bauplan.', [], {chatFn: reply});
  assert.equal(recovery.offline, false);
  const handover = await prepareDeepProjectHandover(project.id);
  assert.equal(handover.ok, true);
  assert.match(handover.idea, /Bauplan: MVP/);
});

test('DeepAgent Villa ownership cannot be reassigned to another project owner', async () => {
  const suffix = process.pid;
  const ownerA = createUser({email: `deepagent-villa-a-${suffix}@example.invalid`, password: 'test-only-password-a', role: 'user'});
  const ownerB = createUser({email: `deepagent-villa-b-${suffix}@example.invalid`, password: 'test-only-password-b', role: 'user'});
  const projectA = await createDeepProject('Privates Deep-Projekt von Nutzer A', {chatFn: reply, ownerUserId: ownerA.id});
  const projectB = await createDeepProject('Privates Deep-Projekt von Nutzer B', {chatFn: reply, ownerUserId: ownerB.id});
  const ts = Date.now();
  const villaId = Number(db.prepare(
    'INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(`Deep owner conflict ${suffix}`, 'private test Villa', 'PLANNING', 12, 1, ts, ts).lastInsertRowid);
  linkDeepProjectVilla(projectA.id, villaId);
  assert.throws(() => linkDeepProjectVilla(projectB.id, villaId), (error) => error.code === 'VILLA_OWNER_CONFLICT');
  assert.equal(db.prepare('SELECT owner_user_id FROM deep_villa_owners WHERE villa_id=?').get(villaId).owner_user_id, ownerA.id);
});

test('DeepAgent development status ignores stale results while pending and uses the current Villa link', async () => {
  const owner = createUser({email: `deepagent-status-${process.pid}@example.invalid`, password: 'test-only-password', role: 'user'});
  const project = await createDeepProject('Eine App mit einer aktuellen Projekt-Villa', {chatFn: reply, ownerUserId: owner.id});
  const villaId = insertVillaRecord({name: 'Deep status Villa', idea: 'private project', ownerUserId: owner.id});
  assert.equal(linkDeepProjectVilla(project.id, villaId), villaId);
  const pending = deepProjectDevelopmentStatus(project.id, true, {ok: true, villaId: villaId + 1000, pending: false});
  assert.deepEqual(pending, {pending: true, villaId});
  const complete = deepProjectDevelopmentStatus(project.id, false, {ok: true, villaId: villaId + 1000, pending: true, started: true});
  assert.deepEqual(complete, {ok: true, started: true, pending: false, villaId});
});

test('Villa owner mapping is committed atomically with the Villa row', () => {
  const owner = createUser({email: `deepagent-atomic-owner-${process.pid}@example.invalid`, password: 'test-only-password', role: 'user'});
  const villaId = insertVillaRecord({name: 'Atomic owner Villa', idea: 'private project', ownerUserId: owner.id});
  const row = db.prepare('SELECT owner_user_id FROM deep_villa_owners WHERE villa_id=?').get(villaId);
  assert.equal(row?.owner_user_id, owner.id);
});

test('Villa insert rolls back when the private owner mapping cannot be written', () => {
  const trigger = `fail_owner_insert_${process.pid}`;
  const name = `Atomic rollback Villa ${process.pid}`;
  db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON deep_villa_owners
    WHEN NEW.owner_user_id = -${process.pid}
    BEGIN SELECT RAISE(ABORT, 'forced owner mapping failure'); END`);
  try {
    assert.throws(() => insertVillaRecord({
      name,
      idea: 'private project',
      ownerUserId: -process.pid
    }), /forced owner mapping failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM villas WHERE name=?').get(name).count, 0);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
});

test('DeepAgent memory never mixes project titles across owners', async () => {
  const suffix = process.pid;
  const ownerAUser = createUser({ email: `deepagent-memory-a-${suffix}@example.invalid`, password: 'test-only-password-a', role: 'user' });
  const ownerBUser = createUser({ email: `deepagent-memory-b-${suffix}@example.invalid`, password: 'test-only-password-b', role: 'user' });
  const ownerA = await createDeepProject('Privates Projekt von Nutzer A mit eigenem Kontext', {
    chatFn: reply,
    ownerUserId: ownerAUser.id
  });
  await createDeepProject('Geheimes Projekt von Nutzer B ohne Freigabe', {
    chatFn: reply,
    ownerUserId: ownerBUser.id
  });
  let systemContext = '';
  await deepChat(ownerA.id, 'Erstelle den nächsten Schritt.', [], {
    chatFn: async (messages) => {
      systemContext = messages[0].content;
      return reply();
    }
  });

  assert.match(systemContext, /Privates Projekt von Nutzer A/);
  assert.doesNotMatch(systemContext, /Geheimes Projekt von Nutzer B/);
});


test('Villa dispatcht Aufgaben strikt einzeln und respektiert die vorbereitete Prioritaetsreihenfolge', () => {
  const first = { id: 11, priority: 1 };
  const second = { id: 12, priority: 2 };
  const third = { id: 13, priority: 3 };
  assert.deepEqual(selectSequentialTaskBatch([first, second, third]), [first]);
  assert.deepEqual(selectSequentialTaskBatch([second]), [second]);
  assert.deepEqual(selectSequentialTaskBatch([]), []);
});
