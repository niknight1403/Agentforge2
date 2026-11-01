import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import {
  ensureSuperadmin,
  SUPERADMIN_EMAIL,
  SUPERADMIN_PWHASH
} from '../seed.mjs';
import {
  verifyPassword,
  hashPassword,
  createUser,
  upsertUser,
  findUser,
  createSession,
  userForToken,
  quotaLeft,
  isAdmin,
  userStore,
  recordLoginFailure,
  loginBlockedFor,
  clearLoginFailures
} from '../auth.mjs';
import { chat } from '../llm.mjs';

test('1. Seed idempotent: ensureSuperadmin legt SUPERADMIN an und ist wiederholbar', () => {
  const first = ensureSuperadmin();
  assert.equal(first.email, SUPERADMIN_EMAIL);
  assert.equal(first.role, 'SUPERADMIN');
  assert.equal(Number(first.is_unlimited), 1);
  assert.equal(first.token_budget, 'UNLIMITED');
  assert.equal(first.pwhash, SUPERADMIN_PWHASH);

  const second = ensureSuperadmin();
  assert.equal(second.id, first.id);
  assert.equal(second.email, SUPERADMIN_EMAIL);
  assert.equal(second.role, 'SUPERADMIN');

  const count = db.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get(SUPERADMIN_EMAIL).c;
  assert.equal(count, 1, 'Superadmin existiert genau einmal');
});

test('2. Login gut / schlecht & Rate-Limiting', () => {
  const testEmail = 'testuser-auth@example.test';
  const testPw = 'testPassword123!';
  const user = upsertUser({ email: testEmail, password: testPw, role: 'user', plan: 'free' });

  // Schlecht
  assert.equal(verifyPassword('wrongPassword', user.pwhash || user.password_hash), false);
  assert.equal(verifyPassword('wrongPassword', SUPERADMIN_PWHASH), false);

  // Gut
  assert.equal(verifyPassword(testPw, user.pwhash || user.password_hash), true);

  // Rate Limiting
  const throttleKey = `${testEmail}|127.0.0.1`;
  clearLoginFailures(throttleKey);
  assert.equal(loginBlockedFor(throttleKey), 0);

  for (let i = 0; i < 4; i++) {
    recordLoginFailure(throttleKey);
    assert.equal(loginBlockedFor(throttleKey), 0, 'Noch nicht gesperrt unter 5 Versuchen');
  }
  recordLoginFailure(throttleKey); // 5. Versuch
  assert.ok(loginBlockedFor(throttleKey) > 0, '5. Versuch sperrt die Login-Bremse');
  clearLoginFailures(throttleKey);
  assert.equal(loginBlockedFor(throttleKey), 0, 'Erfolg loescht die Fehlversuche');
});

test('3. Session-Gueltigkeit: Signierter Session-Token mit 24h Ablauf', () => {
  const email = 'session-user@example.test';
  const user = upsertUser({ email, password: 'password123', role: 'user' });

  const token = createSession(user.id, 24 * 3600 * 1000);
  assert.ok(token, 'Session Token erstellt');
  assert.ok(token.includes('.'), 'Token enthaelt Signatur-Trennzeichen');

  const loaded = userForToken(token);
  assert.ok(loaded);
  assert.equal(loaded.email, email);

  // Expired Session
  const expiredToken = createSession(user.id, -1000);
  assert.equal(userForToken(expiredToken), null, 'Abgelaufener Token wird nicht akzeptiert');
});

test('4. Superadmin-Bypass: Quotas und Rate-Limits werden fuer SUPERADMIN umgangen', async () => {
  const sa = ensureSuperadmin();

  // Quota
  assert.equal(quotaLeft(sa), Infinity, 'SUPERADMIN hat unbegrenztes Kontingent (Infinity)');

  // isAdmin
  const reqMock = { headers: { authorization: `Bearer ${createSession(sa.id)}` } };
  assert.equal(isAdmin(reqMock), true, 'isAdmin erkennt SUPERADMIN via Request-Header');

  // LLM Bypass im Context
  await userStore.run(sa, async () => {
    assert.equal(quotaLeft(userStore.getStore()), Infinity);
  });
});

test('5. Nicht-Superadmin unverdrosselt: Normale Nutzer behalten regulaere Drossel/Quota', () => {
  const email = 'normal-user@example.test';
  const user = upsertUser({ email, password: 'password123', role: 'user', plan: 'free', isUnlimited: false });

  assert.notEqual(quotaLeft(user), Infinity, 'Normaler Nutzer hat endliches Kontingent');
  assert.ok(quotaLeft(user) > 0, 'Normaler Nutzer startet mit rechnerischem Tageskontingent');

  const reqMock = { headers: { authorization: `Bearer ${createSession(user.id)}` } };
  assert.equal(isAdmin(reqMock), false, 'isAdmin liefert false fuer normale Nutzer');
});
