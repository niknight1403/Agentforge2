import { createHash, randomUUID } from 'node:crypto';
import { db, now } from './db.mjs';

db.exec('PRAGMA foreign_keys = ON;');

const SERVER_STATES = new Set(['pending', 'active', 'degraded', 'failed', 'disabled']);
const TRANSPORTS = new Set(['stdio', 'sse', 'http', 'websocket']);
const AUTH_MODES = new Set(['none', 'bearer', 'oauth2']);
const SECRET_KEY = /(?:secret|password|passwd|token|api[_-]?key|client[_-]?secret|authorization|private[_-]?key)/i;
const SENSITIVE_QUERY_PARAMETER = /(?:token|secret|password|passwd|authorization|auth|api[_-]?key|credential|signature|jwt|bearer|session|(?:^|[^a-z0-9])sig(?:$|[^a-z0-9]))/i;

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http','websocket')),
    endpoint TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL DEFAULT '',
    args_json TEXT NOT NULL DEFAULT '[]',
    cwd TEXT NOT NULL DEFAULT '',
    auth_mode TEXT NOT NULL DEFAULT 'none' CHECK (auth_mode IN ('none','bearer','oauth2')),
    credential_ref TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','degraded','failed','disabled')),
    last_error_code TEXT NOT NULL DEFAULT '',
    last_error_at INTEGER,
    last_seen_at INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status, updated_at);
  CREATE TABLE IF NOT EXISTS mcp_tools (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_schema_json TEXT NOT NULL DEFAULT '{}',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    schema_hash TEXT NOT NULL,
    policy_status TEXT NOT NULL DEFAULT 'pending' CHECK (policy_status IN ('pending','approved','blocked')),
    policy_reason TEXT NOT NULL DEFAULT '',
    discovered_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(server_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_tools_policy ON mcp_tools(policy_status, server_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_tools_name ON mcp_tools(name);
  CREATE TABLE IF NOT EXISTS mcp_registry_events (
    id TEXT PRIMARY KEY,
    server_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_registry_events_pending ON mcp_registry_events(published_at, created_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!columns.some((item) => item.name === column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
}
ensureColumn('mcp_registry_events', 'claim_token', "TEXT NOT NULL DEFAULT ''");
ensureColumn('mcp_registry_events', 'claim_expires_at', 'INTEGER');
ensureColumn('mcp_registry_events', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_registry_events_lease ON mcp_registry_events(published_at, claim_expires_at, created_at)');


function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function assertNoSecrets(value, path = 'config') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new TypeError(`Sensitive field ${path}.${key} is not allowed; use credentialRef`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function normalizeDefinition(input) {
  plainObject(input, 'server');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw new TypeError('name must contain 1..120 characters');
  const transport = String(input.transport ?? '');
  if (!TRANSPORTS.has(transport)) throw new TypeError('unsupported MCP transport');
  const authMode = String(input.authMode ?? 'none');
  if (!AUTH_MODES.has(authMode)) throw new TypeError('unsupported authMode');
  const credentialRef = String(input.credentialRef ?? '').trim();
  if (authMode !== 'none' && !credentialRef) throw new TypeError('credentialRef is required for authenticated servers');
  if (authMode === 'none' && credentialRef) throw new TypeError('credentialRef requires an authenticated authMode');

  const config = input.config ?? {};
  plainObject(config, 'config');
  assertNoSecrets(config);
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 2048)) {
    throw new TypeError('args must be an array of strings');
  }

  let endpoint = '';
  let command = '';
  let cwd = '';
  if (transport === 'stdio') {
    command = String(input.command ?? '').trim();
    if (!command || command.length > 1024) throw new TypeError('stdio command is required');
    cwd = String(input.cwd ?? '').trim();
    if (cwd.length > 2048) throw new TypeError('cwd is too long');
  } else {
    const raw = String(input.url ?? '').trim();
    let parsed;
    try { parsed = new URL(raw); } catch { throw new TypeError('valid transport URL is required'); }
    const allowed = transport === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:'];
    if (!allowed.includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new TypeError('transport URL must use an allowed protocol and contain no credentials or fragment');
    }
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) {
        throw new TypeError('transport URL query must not contain credential-like parameters; use credentialRef');
      }
    }
    endpoint = parsed.toString();
  }
  return {
    name, transport, endpoint, command, cwd, args,
    authMode, credentialRef, config,
  };
}

function decodeServer(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, transport: row.transport,
    ...(row.endpoint ? { url: row.endpoint } : {}),
    ...(row.command ? { command: row.command, args: JSON.parse(row.args_json), cwd: row.cwd } : {}),
    authMode: row.auth_mode, credentialRef: row.credential_ref || null,
    config: JSON.parse(row.config_json), status: row.status,
    lastErrorCode: row.last_error_code || null, lastErrorAt: row.last_error_at,
    lastSeenAt: row.last_seen_at, consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('value must be JSON-serializable');
  return encoded;
}

function withRegistryTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function registryEvent(serverId, eventType, payload = {}) {
  db.prepare('INSERT INTO mcp_registry_events (id, server_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), serverId, eventType, JSON.stringify(payload), now());
}

export function registerMcpServer(input) {
  const item = normalizeDefinition(input);
  const timestamp = now();
  const id = randomUUID();
  return withRegistryTransaction(() => {
    db.prepare(`
      INSERT INTO mcp_servers
        (id,name,transport,endpoint,command,args_json,cwd,auth_mode,credential_ref,config_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)
    `).run(id, item.name, item.transport, item.endpoint, item.command, JSON.stringify(item.args), item.cwd,
      item.authMode, item.credentialRef, JSON.stringify(item.config), timestamp, timestamp);
    registryEvent(id, 'mcp.server.registered', { name: item.name, transport: item.transport });
    return getMcpServer(id);
  });
}

export function updateMcpServer(id, input) {
  const current = getMcpServer(id);
  if (!current) return null;
  const item = normalizeDefinition({ ...input, name: input.name ?? current.name });
  const timestamp = now();
  return withRegistryTransaction(() => {
    db.prepare(`
      UPDATE mcp_servers SET name=?,transport=?,endpoint=?,command=?,args_json=?,cwd=?,auth_mode=?,
        credential_ref=?,config_json=?,status='pending',last_error_code='',updated_at=? WHERE id=?
    `).run(item.name, item.transport, item.endpoint, item.command, JSON.stringify(item.args), item.cwd,
      item.authMode, item.credentialRef, JSON.stringify(item.config), timestamp, id);
    db.prepare("UPDATE mcp_tools SET policy_status='pending', policy_reason='server_definition_changed', updated_at=? WHERE server_id=?")
      .run(timestamp, id);
    registryEvent(id, 'mcp.server.updated', { name: item.name });
    return getMcpServer(id);
  });
}

export function getMcpServer(id) {
  return decodeServer(db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(String(id)));
}

export function listMcpServers({ status, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const rows = status
    ? db.prepare('SELECT * FROM mcp_servers WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, safeLimit, safeOffset)
    : db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC LIMIT ? OFFSET ?').all(safeLimit, safeOffset);
  return rows.map(decodeServer);
}

export function setMcpServerStatus(id, status, { errorCode = null } = {}) {
  if (!SERVER_STATES.has(status)) throw new TypeError('invalid MCP server status');
  const timestamp = now();
  return withRegistryTransaction(() => {
    const result = db.prepare(`
      UPDATE mcp_servers SET status=?, last_error_code=?, last_error_at=?, last_seen_at=?,
        consecutive_failures=CASE WHEN ?='active' THEN 0 WHEN ? IN ('degraded','failed') THEN consecutive_failures+1 ELSE consecutive_failures END,
        updated_at=? WHERE id=?
    `).run(status, errorCode ? String(errorCode).slice(0, 120) : '', errorCode ? timestamp : null,
      status === 'active' ? timestamp : null, status, status, timestamp, String(id));
    if (!result.changes) return null;
    registryEvent(String(id), 'mcp.server.status_changed', { status, errorCode: errorCode ? String(errorCode).slice(0, 120) : null });
    return getMcpServer(id);
  });
}

export function removeMcpServer(id) {
  const server = getMcpServer(id);
  if (!server) return false;
  return withRegistryTransaction(() => {
    db.prepare('DELETE FROM mcp_servers WHERE id=?').run(String(id));
    registryEvent(null, 'mcp.server.removed', { serverId: String(id), name: server.name });
    return true;
  });
}

export function replaceMcpServerTools(serverId, tools) {
  if (!getMcpServer(serverId)) throw new Error('MCP_SERVER_NOT_FOUND');
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
  const timestamp = now();
  const upsert = db.prepare(`
    INSERT INTO mcp_tools (id,server_id,name,description,input_schema_json,capabilities_json,schema_hash,policy_status,discovered_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'pending',?,?)
    ON CONFLICT(server_id,name) DO UPDATE SET
      description=excluded.description,
      input_schema_json=excluded.input_schema_json,
      capabilities_json=excluded.capabilities_json,
      policy_status=CASE WHEN mcp_tools.schema_hash=excluded.schema_hash THEN mcp_tools.policy_status ELSE 'pending' END,
      policy_reason=CASE WHEN mcp_tools.schema_hash=excluded.schema_hash THEN mcp_tools.policy_reason ELSE 'schema_changed' END,
      schema_hash=excluded.schema_hash, updated_at=excluded.updated_at
  `);
  const names = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const tool of tools) {
      plainObject(tool, 'tool');
      const name = String(tool.name ?? '').trim();
      if (!name || name.length > 160 || names.has(name)) throw new TypeError('tool names must be unique and 1..160 characters');
      names.add(name);
      const description = String(tool.description ?? '');
      const schema = tool.inputSchema ?? {};
      plainObject(schema, 'inputSchema');
      const rawCapabilities = tool.capabilities ?? [];
      if (!Array.isArray(rawCapabilities) || rawCapabilities.some((item) => typeof item !== 'string' || !item.trim() || item.length > 80)) {
        throw new TypeError('capabilities must be an array of non-empty strings up to 80 characters');
      }
      if (description.length > 4000) throw new TypeError('tool description is too long');
      const capabilities = [...new Set(rawCapabilities.map((item) => item.trim()))].slice(0, 40);
      const schemaJson = stableJson(schema);
      const capsJson = JSON.stringify(capabilities);
      const hash = createHash('sha256').update(schemaJson).digest('hex');
      const existing = db.prepare('SELECT id FROM mcp_tools WHERE server_id=? AND name=?').get(String(serverId), name);
      upsert.run(existing?.id ?? randomUUID(), String(serverId), name, description, schemaJson, capsJson, hash, timestamp, timestamp);
    }
    if (names.size) {
      const placeholders = [...names].map(() => '?').join(',');
      db.prepare(`DELETE FROM mcp_tools WHERE server_id=? AND name NOT IN (${placeholders})`).run(String(serverId), ...names);
    } else {
      db.prepare('DELETE FROM mcp_tools WHERE server_id=?').run(String(serverId));
    }
    registryEvent(String(serverId), 'mcp.tools.discovered', { count: names.size });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listMcpTools({ serverId });
}

export function listMcpTools({ serverId, policyStatus, limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const clauses = [];
  const params = [];
  if (serverId) { clauses.push('server_id=?'); params.push(String(serverId)); }
  if (policyStatus) { clauses.push('policy_status=?'); params.push(String(policyStatus)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM mcp_tools ${where} ORDER BY name LIMIT ?`).all(...params, safeLimit).map((row) => ({
    id: row.id, serverId: row.server_id, name: row.name, description: row.description,
    inputSchema: JSON.parse(row.input_schema_json), capabilities: JSON.parse(row.capabilities_json),
    schemaHash: row.schema_hash, policyStatus: row.policy_status, policyReason: row.policy_reason,
    discoveredAt: row.discovered_at, updatedAt: row.updated_at,
  }));
}

export function setMcpToolPolicy(id, policyStatus, reason = '') {
  if (!['pending', 'approved', 'blocked'].includes(policyStatus)) throw new TypeError('invalid tool policy status');
  return withRegistryTransaction(() => {
    const result = db.prepare('UPDATE mcp_tools SET policy_status=?,policy_reason=?,updated_at=? WHERE id=?')
      .run(policyStatus, String(reason).slice(0, 500), now(), String(id));
    if (!result.changes) return null;
    const row = db.prepare('SELECT * FROM mcp_tools WHERE id=?').get(String(id));
    registryEvent(row.server_id, 'mcp.tool.policy_changed', {
      toolId: row.id, name: row.name, policyStatus, reason: String(reason).slice(0, 500),
    });
    return row;
  });
}

export function claimMcpRegistryEvents(limit = 100, { leaseMs = 30_000 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw new TypeError('leaseMs must be an integer between 1000 and 900000');
  }
  return withRegistryTransaction(() => {
    const timestamp = now();
    const eligible = db.prepare(
      "SELECT id FROM mcp_registry_events WHERE published_at IS NULL AND (claim_token='' OR claim_expires_at IS NULL OR claim_expires_at<=?) ORDER BY created_at LIMIT ?"
    ).all(timestamp, safeLimit);
    const claim = db.prepare(
      "UPDATE mcp_registry_events SET claim_token=?, claim_expires_at=?, attempts=attempts+1 WHERE id=? AND published_at IS NULL AND (claim_token='' OR claim_expires_at IS NULL OR claim_expires_at<=?)"
    );
    const read = db.prepare('SELECT * FROM mcp_registry_events WHERE id=?');
    const claimed = [];
    for (const item of eligible) {
      const claimToken = randomUUID();
      const expiresAt = timestamp + leaseMs;
      if (!claim.run(claimToken, expiresAt, item.id, timestamp).changes) continue;
      const row = read.get(item.id);
      claimed.push({ id: row.id, serverId: row.server_id, type: row.event_type,
        payload: JSON.parse(row.payload_json), createdAt: row.created_at,
        claimToken: row.claim_token, leaseExpiresAt: row.claim_expires_at, attempts: row.attempts });
    }
    return claimed;
  });
}

export function markMcpRegistryEventPublished(id, claimToken) {
  if (typeof claimToken !== 'string' || !claimToken) return false;
  return db.prepare(
    "UPDATE mcp_registry_events SET published_at=?, claim_token='', claim_expires_at=NULL WHERE id=? AND published_at IS NULL AND claim_token=?"
  ).run(now(), String(id), claimToken).changes > 0;
}
