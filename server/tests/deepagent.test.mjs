import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TMP } from './_env.mjs';

process.env.DEEP_DIR = join(TMP, 'deep-files');
const { createDeepProject, deepChat, addDeepFile, deleteDeepProject, listDeepProjects, deepProjectDetail, linkDeepProjectVilla } = await import('../deepagent.mjs');
const reply = async () => ({ content: 'Bauplan: MVP, Tests und Startanleitung.' });

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
