import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { db } from '../db.mjs';

process.env.MCP_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');
const { storeMcpCredential, readMcpCredential, deleteMcpCredential } = await import('../mcp-credential-vault.mjs');

test('MCP vault encrypts credentials at rest and decrypts only by reference', () => {
  const secret = 'test-token-never-store-in-plaintext';
  const stored = storeMcpCredential(secret);
  assert.match(stored.credentialRef, /^mcpcred:/);
  const row = db.prepare('SELECT ciphertext, nonce, auth_tag FROM mcp_credentials WHERE id=?')
    .get(stored.credentialRef.slice('mcpcred:'.length));
  assert.ok(row);
  assert.notEqual(Buffer.from(row.ciphertext).toString('utf8'), secret);
  assert.equal(readMcpCredential(stored.credentialRef), secret);
});

test('MCP vault rejects missing or malformed master keys and credential references', () => {
  const stored = storeMcpCredential('another-secret');
  assert.throws(() => readMcpCredential('not-a-reference'), { code: 'MCP_INVALID_CREDENTIAL_REF' });
  const key = process.env.MCP_CREDENTIAL_MASTER_KEY;
  process.env.MCP_CREDENTIAL_MASTER_KEY = 'invalid';
  assert.throws(() => readMcpCredential(stored.credentialRef), { code: 'MCP_VAULT_KEY_MISSING_OR_INVALID' });
  process.env.MCP_CREDENTIAL_MASTER_KEY = key;
  assert.throws(() => storeMcpCredential(''), { code: 'MCP_INVALID_CREDENTIAL' });
});

test('MCP vault authenticates ciphertext and supports explicit deletion', () => {
  const stored = storeMcpCredential('tamper-detection-secret');
  const id = stored.credentialRef.slice('mcpcred:'.length);
  db.prepare('UPDATE mcp_credentials SET ciphertext=? WHERE id=?').run(Buffer.from('tampered'), id);
  assert.throws(() => readMcpCredential(stored.credentialRef), { code: 'MCP_VAULT_DECRYPT_FAILED' });
  const other = storeMcpCredential('delete-me');
  assert.equal(deleteMcpCredential(other.credentialRef), true);
  assert.equal(readMcpCredential(other.credentialRef), null);
  assert.equal(deleteMcpCredential(other.credentialRef), false);
});
