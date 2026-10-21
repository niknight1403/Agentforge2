import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TMP } from './_env.mjs';

process.env.DEEP_DIR = join(TMP, 'deep-files');
const { createDeepProject, deepChat, addDeepFile } = await import('../deepagent.mjs');
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
  assert.match(sent[0].content, /Behaupte bei Anhaengen keine Analyse/);
});

test('Deep Agent sichert Nachrichten bei echtem LLM-Ausfall und antwortet ehrlich', async () => {
  const project = await createDeepProject('Eine App für professionelle Projektplanung', { chatFn: reply });
  const unavailable = Object.assign(new Error('Keine Route erreichbar'), { code: 'LLM_UNAVAILABLE' });
  const result = await deepChat(project.id, 'Baue jetzt den Export.', [], { chatFn: async () => { throw unavailable; } });
  assert.equal(result.offline, true);
  assert.match(result.reply, /kein Sprachmodell erreichbar/i);
});
