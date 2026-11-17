import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { db, now } from './db.mjs';

const KEY_ENV = 'MCP_CREDENTIAL_MASTER_KEY';
const KEY_VERSION = 1;
const MAX_CREDENTIAL_BYTES = 64 * 1024;

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_credentials (
    id TEXT PRIMARY KEY,
    key_version INTEGER NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_credentials_updated ON mcp_credentials(updated_at);
`);

function masterKey() {
  const encoded = process.env[KEY_ENV];
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    const error = new Error(`${KEY_ENV} must be a base64-encoded 32-byte key`);
    error.code = 'MCP_VAULT_KEY_MISSING_OR_INVALID';
    throw error;
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    const error = new Error(`${KEY_ENV} must be a base64-encoded 32-byte key`);
    error.code = 'MCP_VAULT_KEY_MISSING_OR_INVALID';
    throw error;
  }
  return key;
}

function normalizeCredential(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) {
    const error = new TypeError('credential must be a non-empty string of at most 64 KiB');
    error.code = 'MCP_INVALID_CREDENTIAL';
    throw error;
  }
  return value;
}

function aad(id, version) {
  return Buffer.from(`agentforge2:mcp-credential:${version}:${id}`, 'utf8');
}

/** Encrypts a credential before it reaches SQLite. The master key is never stored. */
export function storeMcpCredential(value) {
  const plaintext = normalizeCredential(value);
  const key = masterKey();
  const id = randomUUID();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(id, KEY_VERSION));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const timestamp = now();
  db.prepare(`
    INSERT INTO mcp_credentials (id,key_version,nonce,ciphertext,auth_tag,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, KEY_VERSION, nonce, ciphertext, authTag, timestamp, timestamp);
  return { credentialRef: `mcpcred:${id}`, keyVersion: KEY_VERSION };
}

/** Checks whether a syntactically valid credential reference exists without decrypting it. */
export function hasMcpCredential(credentialRef) {
  if (typeof credentialRef !== 'string' || !/^mcpcred:[0-9a-f-]{36}$/i.test(credentialRef)) return false;
  return Boolean(db.prepare('SELECT 1 FROM mcp_credentials WHERE id=?').get(credentialRef.slice('mcpcred:'.length)));
}

/** Decrypts only for trusted runtime adapters; never log or persist the returned value. */
export function readMcpCredential(credentialRef) {
  if (typeof credentialRef !== 'string' || !/^mcpcred:[0-9a-f-]{36}$/i.test(credentialRef)) {
    const error = new TypeError('credentialRef is invalid');
    error.code = 'MCP_INVALID_CREDENTIAL_REF';
    throw error;
  }
  const id = credentialRef.slice('mcpcred:'.length);
  const row = db.prepare('SELECT * FROM mcp_credentials WHERE id=?').get(id);
  if (!row) return null;
  if (row.key_version !== KEY_VERSION) {
    const error = new Error('MCP credential uses an unsupported key version');
    error.code = 'MCP_VAULT_KEY_VERSION_UNSUPPORTED';
    throw error;
  }
  const key = masterKey();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
    decipher.setAAD(aad(id, row.key_version));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    const error = new Error('MCP credential could not be authenticated or decrypted');
    error.code = 'MCP_VAULT_DECRYPT_FAILED';
    throw error;
  }
}

export function deleteMcpCredential(credentialRef) {
  if (typeof credentialRef !== 'string' || !/^mcpcred:[0-9a-f-]{36}$/i.test(credentialRef)) {
    const error = new TypeError('credentialRef is invalid');
    error.code = 'MCP_INVALID_CREDENTIAL_REF';
    throw error;
  }
  const result = db.prepare('DELETE FROM mcp_credentials WHERE id=?').run(credentialRef.slice('mcpcred:'.length));
  return result.changes === 1;
}
