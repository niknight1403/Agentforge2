import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertUser, createSession, userForToken, verifyPassword, findUser } from '../auth.mjs';

test('same admin password keeps sessions; rotating it revokes all old sessions', () => {
  const email = 'rotation@example.test';
  const first = upsertUser({ email, password: 'initial-passphrase', role: 'admin', plan: 'elite' });
  const tokenA = createSession(first.id);
  const tokenB = createSession(first.id);
  assert.ok(userForToken(tokenA));
  assert.ok(userForToken(tokenB));

  upsertUser({ email, password: 'initial-passphrase', role: 'admin', plan: 'elite' });
  assert.ok(userForToken(tokenA), 'a routine startup with the same password must preserve sessions');

  upsertUser({ email, password: 'rotated-passphrase', role: 'admin', plan: 'elite' });
  assert.equal(userForToken(tokenA), null);
  assert.equal(userForToken(tokenB), null);
  assert.equal(verifyPassword('initial-passphrase', findUser(email).password_hash), false);
  assert.equal(verifyPassword('rotated-passphrase', findUser(email).password_hash), true);
});
