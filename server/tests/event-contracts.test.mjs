import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeshEvent } from '../event-mesh.mjs';
import {
  MESH_EVENT_TYPES, MESH_METADATA_FIELDS, MESH_TEXT_MAX,
  MESH_EVENT_CONTRACTS, validateMeshEvent, assertMeshEvent,
} from '../event-contracts.mjs';

const VILLA = 5, TASK = 42, AGENT = 7;

test('alle vom Bus erzeugten Event-Typen sind vertragskonform', () => {
  const samples = [
    buildMeshEvent('task', { villaId: VILLA, taskId: TASK, status: 'PENDING' }),
    buildMeshEvent('task', { villaId: VILLA, taskId: TASK, status: 'RUNNING', step: 2 }),
    buildMeshEvent('task', { villaId: VILLA, taskId: TASK, status: 'DONE', durationMs: 1200 }),
    buildMeshEvent('task', { villaId: VILLA, taskId: TASK, status: 'FAILED', code: 'E_TIMEOUT' }),
    buildMeshEvent('tool', { villaId: VILLA, taskId: TASK, agentId: AGENT, tool: 'project_write', durationMs: 300, blocked: false }),
    buildMeshEvent('llm', { provider: 'groq', model: 'gpt-oss-120b', route: 'Cascade', latencyMs: 900, tokensUsed: 700, costUsd: 0 }),
    buildMeshEvent('llm.failed', { code: 'RATE_LIMIT', provider: 'groq' }),
    buildMeshEvent('checkpoint', { checkpointId: 'cp-1', villaId: VILLA, taskId: TASK, step: 3 }),
    buildMeshEvent('agent.step.started', { villaId: VILLA, agentId: AGENT, provider: 'groq', model: 'x' }),
  ];
  for (const event of samples) {
    assert.ok(event, 'Event darf nicht null sein');
    const result = validateMeshEvent(event);
    assert.equal(result.ok, true, `${event.type} verletzt Vertrag: ${result.errors.join(', ')}`);
  }
});

test('unbekannte Zwischen-Typen werden nicht als Event publiziert', () => {
  assert.equal(buildMeshEvent('voellig-unbekannt', { villaId: 1 }), null);
});

test('Metadaten-Whitelist verhindert das Durchsickern von Inhalten', () => {
  const event = buildMeshEvent('tool', {
    villaId: VILLA, tool: 'project_write',
    prompt: 'GEHEIMER PROMPT', toolArgs: { secret: true }, response: 'Antworttext', thoughts: 'intern',
  });
  assert.equal(event.prompt, undefined);
  assert.equal(event.toolArgs, undefined);
  assert.equal(event.response, undefined);
  assert.equal(event.thoughts, undefined);
  assert.equal(validateMeshEvent(event).ok, true);
});

test('zu lange Textwerte werden gekuerzt und bleiben gueltig', () => {
  const event = buildMeshEvent('tool', { villaId: VILLA, tool: 'x'.repeat(400) });
  assert.equal(event.tool.length, MESH_TEXT_MAX);
  assert.equal(validateMeshEvent(event).ok, true, 'gekuerzter Wert muss gueltig sein');
});

test('Validator erkennt fehlende Pflichtfelder', () => {
  const { ok, errors } = validateMeshEvent({ id: 'e1', type: 'tool.executed', at: Date.now(), villaId: VILLA });
  assert.equal(ok, false);
  assert.ok(errors.includes('required_missing:tool'));
});

test('Validator erkennt unbekannten Typ und fehlende Huelle', () => {
  assert.equal(validateMeshEvent({ id: 'e1', type: 'gibt.es.nicht', at: 1 }).ok, false);
  assert.equal(validateMeshEvent(null).ok, false);
  assert.deepEqual(validateMeshEvent(null).errors, ['event_must_be_object']);
});

test('Validator erkennt Fremdfelder und falsche Typen', () => {
  const base = { id: 'e1', type: 'llm.completed', at: 1, provider: 'groq' };
  assert.equal(validateMeshEvent({ ...base, prompt: 'x' }).ok, false, 'Fremdfeld muss auffallen');
  assert.equal(validateMeshEvent({ ...base, tokensUsed: { n: 1 } }).ok, false, 'Objekt statt Zahl');
  assert.equal(validateMeshEvent({ ...base, tokensUsed: Number.NaN }).ok, false, 'NaN');
  assert.equal(validateMeshEvent({ id: '', type: 'llm.completed', at: 1, provider: 'groq' }).ok, false, 'leere id');
});

test('Vertrags-Tabelle deckt jeden Event-Typ mit Pflichtfeldern ab', () => {
  assert.equal(MESH_EVENT_TYPES.length, Object.keys(MESH_EVENT_CONTRACTS).length);
  for (const type of MESH_EVENT_TYPES) {
    assert.ok(Array.isArray(MESH_EVENT_CONTRACTS[type].required), `${type} braucht required`);
    assert.ok(MESH_EVENT_CONTRACTS[type].required.length > 0, `${type} braucht mindestens ein Pflichtfeld`);
  }
  assert.ok(MESH_METADATA_FIELDS.includes('villaId'));
});

test('assertMeshEvent wirft bei Vertragsbruch', () => {
  assert.throws(() => assertMeshEvent({ id: 'e1', type: 'tool.executed', at: 1 }), /verletzt Vertrag/);
  const good = buildMeshEvent('tool', { villaId: VILLA, tool: 'read_file' });
  assert.equal(assertMeshEvent(good), good);
});
