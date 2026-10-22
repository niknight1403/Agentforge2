import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKey, PROVIDER_CATALOG, nextFreePriority } from '../keyforge.mjs';

test('classifyKey erkennt Provider anhand der Key-Struktur', () => {
  assert.equal(classifyKey('gsk_vZrOCp123'), 'groq');
  assert.equal(classifyKey('sk-or-v1-abc123'), 'openrouter');
  assert.equal(classifyKey('AIzaSyABCDEF'), 'google');
  assert.equal(classifyKey('xai-abc123'), 'xai');
  assert.equal(classifyKey('csk-abc123'), 'cerebras');
  assert.equal(classifyKey('hf_abc123'), 'huggingface');
  assert.equal(classifyKey('Ab8RN6KoYN1234567890'), null, 'unbekannte Struktur wird nicht geroutet');
  assert.equal(classifyKey(''), null);
  assert.equal(classifyKey(null), null);
});

test('KeyForge-Katalog: jeder Provider hat BaseUrl, Probe-Modell und Routen-Modelle', () => {
  for (const [id, spec] of Object.entries(PROVIDER_CATALOG)) {
    assert.ok(spec.baseUrl.startsWith('https://'), `${id} baseUrl`);
    if (id === 'xai') { assert.equal(spec.probeModel, ''); assert.deepEqual(spec.models, []); }
    else { assert.ok(spec.probeModel.length > 0, `${id} probeModel`); assert.ok(spec.models.length > 0, `${id} models`); }
    assert.equal(typeof spec.routeOn429, 'boolean', `${id} routeOn429`);
    assert.ok(spec.routeProvider, `${id} routeProvider`);
  }
});

test('nextFreePriority: vergibt den kleinsten freien Block ab 8 und bleibt deterministisch', () => {
  const p = nextFreePriority(2);
  assert.ok(p >= 8, 'unter 8 liegt die manuelle Route-Verwaltung');
  assert.ok(p % 2 === 0, 'Bloecke starten auf geraden Prio-Werten');
});
