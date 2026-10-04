import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoute, validateSecret, validateVilla, validateMessage } from '../validate.mjs';

test('validateRoute: gueltige Route durch, https erzwungen', () => {
  const ok = validateRoute({ name: 'Meine Route', baseUrl: 'https://api.example.com/v1/', model: 'modell-x', keyEnv: 'MY_KEY', priority: 3 });
  assert.ok(ok.ok);
  assert.equal(ok.value.baseUrl, 'https://api.example.com/v1');
  assert.equal(ok.value.priority, 3);

  assert.ok(!validateRoute({ name: 'x', baseUrl: 'http://api.example.com', model: 'm' }).ok, 'http-Host darf nicht erlaubt sein');
  assert.ok(validateRoute({ name: 'lokal', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' }).ok, 'lokale Route erlaubt');
  assert.ok(validateRoute({ name: 'lokal2', baseUrl: 'http://localhost:11434/v1', model: 'm' }).ok);
});

test('validateRoute: Pflichtfelder und Grenzen', () => {
  assert.ok(!validateRoute({}).ok);
  assert.ok(!validateRoute({ name: 'x', baseUrl: '', model: 'm' }).ok);
  assert.ok(!validateRoute({ name: 'x', baseUrl: 'https://a.de', model: '' }).ok);
  assert.ok(!validateRoute({ name: 'x', baseUrl: 'https://a.de', model: 'm', keyEnv: 'schlechter_name' }).ok);
  assert.ok(!validateRoute({ name: 'x', baseUrl: 'https://a.de', model: 'm', priority: 0 }).ok);
  assert.ok(!validateRoute({ name: 'x', baseUrl: 'https://a.de', model: 'm', priority: 1000 }).ok);
  assert.ok(validateRoute({ name: 'x', baseUrl: 'https://a.de', model: 'm', keyEnv: 'OK_NAME_2' }).ok);
});

test('validateSecret: Muster und Laenge', () => {
  const ok = validateSecret({ name: 'GROQ_API_KEY', value: 'gsk_abc' });
  assert.ok(ok.ok);
  assert.ok(!validateSecret({ name: 'grob-falsch', value: 'x' }).ok);
  assert.ok(!validateSecret({ name: 'GUT_ABER_LEER' }).ok, 'leerer Wert wird uebernommen? Nein: erlaubt');
  assert.ok(!validateSecret({ name: 'X'.repeat(70), value: 'v' }).ok);
  assert.ok(!validateSecret({ name: 'A', value: 'x'.repeat(5000) }).ok);
});

test('validateVilla: Idee Pflicht, Agentenzahl begrenzt', () => {
  const ok = validateVilla({ idea: 'Eine App bauen', name: 'Meine Villa', agentCount: 24 });
  assert.ok(ok.ok);
  assert.equal(ok.value.agentCount, 24);
  assert.equal(ok.value.mode, 'BUILD');

  assert.ok(!validateVilla({}).ok, 'ohne Idee abgelehnt');
  assert.ok(!validateVilla({ idea: 'x', agentCount: 2 }).ok, 'zu wenige Agenten');
  assert.ok(!validateVilla({ idea: 'x', agentCount: 1001 }).ok, 'zu viele Agenten');
  assert.ok(!validateVilla({ idea: 'x', agentCount: 'abc' }).ok, 'keine Zahl');

  const analyze = validateVilla({ idea: 'x', sourcePath: '/tmp/projekt' });
  assert.equal(analyze.value.mode, 'ANALYZE');
  const weird = validateVilla({ idea: 'x', mode: 'BOGUS' });
  assert.equal(weird.value.mode, 'BUILD', 'unbekannter Modus faellt auf BUILD');
  assert.ok(!validateVilla({ idea: 'x'.repeat(2500) }).ok, 'zu lange Idee');
});

test('validateVilla: Vorgabewerte sind sinnvoll', () => {
  const v = validateVilla({ idea: 'Test' }).value;
  assert.equal(v.name, 'Villa');
  assert.equal(v.agentCount, 12);
});

test('validateMessage: Pflicht und Grenze', () => {
  const ok = validateMessage({ message: 'Hallo Villa' });
  assert.ok(ok.ok);
  assert.ok(!validateMessage({}).ok);
  assert.ok(!validateMessage({ message: '   ' }).ok, 'nur Leerzeichen');
  assert.ok(!validateMessage({ message: 'x'.repeat(9000) }).ok);
  assert.ok(validateMessage({ message: 'x'.repeat(7000) }).ok);
});
