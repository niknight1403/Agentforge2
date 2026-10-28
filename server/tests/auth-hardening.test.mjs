import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loginBlockedFor, recordLoginFailure, clearLoginFailures } from '../auth.mjs';

const KEY = 'user@example.com|10.0.0.1';
const T0 = 1_800_000_000_000;

test('Login-Bremse: unter der Schwelle wird nicht gesperrt', () => {
  clearLoginFailures(KEY);
  for (let i = 0; i < 4; i += 1) recordLoginFailure(KEY, T0 + i);
  assert.equal(loginBlockedFor(KEY, T0 + 10), 0);
});

test('Login-Bremse: fuenfter Fehlversuch sperrt 15 Minuten', () => {
  clearLoginFailures(KEY);
  for (let i = 0; i < 5; i += 1) recordLoginFailure(KEY, T0 + i);
  const blocked = loginBlockedFor(KEY, T0 + 10);
  assert.equal(blocked, 15 * 60 * 1000 - 10);
  assert.equal(loginBlockedFor(KEY, T0 + 16 * 60 * 1000), 0);
});

test('Login-Bremse: Erfolg loescht die Fehlversuche', () => {
  clearLoginFailures(KEY);
  for (let i = 0; i < 4; i += 1) recordLoginFailure(KEY, T0 + i);
  clearLoginFailures(KEY);
  assert.equal(loginBlockedFor(KEY, T0 + 10), 0);
  recordLoginFailure(KEY, T0 + 20);
  assert.equal(loginBlockedFor(KEY, T0 + 30), 0, 'Zaehler startet nach Erfolg neu');
});

test('Login-Bremse: altes Fenster resettet den Zaehler', () => {
  clearLoginFailures(KEY);
  for (let i = 0; i < 4; i += 1) recordLoginFailure(KEY, T0 + i);
  recordLoginFailure(KEY, T0 + 16 * 60 * 1000);
  assert.equal(loginBlockedFor(KEY, T0 + 16 * 60 * 1000 + 5), 0, 'kein Sperren ueber Fenstergrenze');
});

test('Login-Bremse: verschiedene Schluessel stoeren sich nicht', () => {
  clearLoginFailures(KEY);
  for (let i = 0; i < 5; i += 1) recordLoginFailure(KEY, T0 + i);
  assert.ok(loginBlockedFor(KEY, T0 + 10) > 0);
  assert.equal(loginBlockedFor('other@example.com|10.0.0.2', T0 + 10), 0);
});
