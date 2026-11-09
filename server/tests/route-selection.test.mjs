import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouteAdmission, accountOf, limitsOf, isLocalEndpoint } from '../route-selection.mjs';

const local = { id: 1, name: 'ollama-local', provider: 'ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b', key_env: '' };
const cloud = { id: 2, name: 'gemini-free', provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', key_env: 'GEMINI_API_KEY' };
const cloudZweit = { id: 3, name: 'gemini-zweit', provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', key_env: 'GEMINI_API_KEY' };

test('lokaler Endpunkt wird erkannt, Cloud nicht', () => {
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://host.docker.internal:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://192.168.1.20:11434/v1'), true);
  assert.equal(isLocalEndpoint('https://api.groq.com/openai/v1'), false);
});

test('Konto ist der Schluessel, sonst der Anbieter', () => {
  assert.equal(accountOf(cloud), 'key:GEMINI_API_KEY');
  assert.equal(accountOf(cloudZweit), 'key:GEMINI_API_KEY');
  assert.equal(accountOf(local), 'provider:ollama');
});

test('Limits kommen vom Anbieter und werden von der Konfiguration ueberschrieben', () => {
  assert.equal(limitsOf(cloud).rpd, 1200);
  const mitConfig = limitsOf(cloud, [{ id: 'gemini-free', limits: { rpd: 42, rpm: 3 } }]);
  assert.equal(mitConfig.rpd, 42);
  assert.equal(mitConfig.rpm, 3);
  assert.equal(limitsOf(local).rpd, 0, 'lokal ist unbegrenzt');
});

test('ohne Schalter bleibt der Pfad unveraendert', () => {
  const gate = createRouteAdmission({ env: {} });
  assert.equal(gate.enabled, false);
  assert.equal(gate.admit(cloud, { tokens: 500 }).ok, true);
});

test('mit Schalter: nur lokale Route zugelassen (Standard)', () => {
  const gate = createRouteAdmission({ env: { VF_ROUTE_LEDGER: '1' } });
  assert.equal(gate.localOnly, true, 'LLM_LOCAL_ONLY ist standardmaessig an');
  const cloudVersuch = gate.admit(cloud, { tokens: 500 });
  assert.equal(cloudVersuch.ok, false);
  assert.equal(cloudVersuch.reason, 'local_only');
  assert.equal(gate.admit(local, { tokens: 500 }).ok, true);
});

test('mit LLM_LOCAL_ONLY=0 und Tageslimit: Verweigerung nennt den Grund', () => {
  const gate = createRouteAdmission({
    env: { VF_ROUTE_LEDGER: '1', LLM_LOCAL_ONLY: '0' },
    overrides: [{ id: 'gemini-free', limits: { rpm: 50, rpd: 2, tpm: 0, tpd: 0 } }]
  });
  assert.equal(gate.admit(cloud, { tokens: 100 }).ok, true);
  assert.equal(gate.admit(cloud, { tokens: 100 }).ok, true);
  const dritter = gate.admit(cloud, { tokens: 100 });
  assert.equal(dritter.ok, false);
  assert.equal(dritter.reason, 'rpd');
});

test('429 auf einer Route sperrt die Schwesterroute desselben Schluessels', () => {
  const gate = createRouteAdmission({ env: { VF_ROUTE_LEDGER: '1', LLM_LOCAL_ONLY: '0' } });
  gate.admit(cloud, { tokens: 100 });
  gate.settle(cloud, { ok: false, status: 429, retryAfterMs: 60_000 });
  const schwester = gate.admit(cloudZweit, { tokens: 100 });
  assert.equal(schwester.ok, false);
  assert.equal(schwester.reason, 'cooldown');
});

test('nur lokale Kandidaten, wenn localOnly gilt', () => {
  const gate = createRouteAdmission({ env: { VF_ROUTE_LEDGER: '1' } });
  const auswahl = gate.next([cloud, cloudZweit], { tokens: 100 });
  assert.equal(auswahl.route, null);
  assert.equal(auswahl.reason, 'local_only');
  const mitLokal = gate.next([cloud, local], { tokens: 100 });
  assert.equal(mitLokal.route.id, 1);
});
