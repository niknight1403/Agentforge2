import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, buildSystemPrompt, PROMPT_VERSION } from '../agents.mjs';

const CORE = ['AUTOPILOT','SYSTEM_HACKER','PROGRAMMER','MONEY','MULTITALENT','ULTRA'];

test('Apex core roles are registered and receive dedicated prompts', () => {
  for (const role of CORE) {
    assert.ok(ROLES.includes(role), role + ' must be registered');
    const prompt = buildSystemPrompt(role);
    assert.match(prompt, new RegExp('Rolle: ' + role));
    assert.ok(prompt.length > 500, role + ' prompt should contain operational guidance');
  }
  assert.ok(PROMPT_VERSION >= 6);
});

test('system hacker is explicitly scoped to authorized security work', () => {
  const prompt = buildSystemPrompt('SYSTEM_HACKER');
  assert.match(prompt, /autorisiert|autorisierte/i);
  assert.match(prompt, /Keine Angriffe auf fremde Systeme/i);
});

test('ultra agent uses measurable learning instead of fake omnipotence', () => {
  const prompt = buildSystemPrompt('ULTRA');
  assert.match(prompt, /messbares Lernen/i);
  assert.match(prompt, /nicht allwissend/i);
  assert.match(prompt, /memory_write/i);
});
