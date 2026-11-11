import { createHash, randomUUID } from 'node:crypto';
import { db, now } from './db.mjs';
import { getMcpServer, listMcpTools } from './mcp-registry.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_tool_execution_audit (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_sha256 TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','failed','timeout')),
    error_code TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_execution_audit_server ON mcp_tool_execution_audit(server_id, created_at);
`);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertJsonSafe(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must not contain non-finite numbers');
    return;
  }
  if (typeof value !== 'object') throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must contain only JSON values');
  if (seen.has(value)) throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must not contain circular references');
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : (prototype !== Object.prototype && prototype !== null)) {
    throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must use plain JSON objects and arrays');
  }
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (isArray) {
      if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\\d*)$/.test(key)))) {
        throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool argument arrays must not contain custom properties');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool argument arrays must not contain holes');
        assertJsonSafe(value[index], seen);
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must not contain symbol keys');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must contain only enumerable data properties');
        }
        assertJsonSafe(descriptor.value, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function jsonBytes(value, code, label, maxBytes) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch {
    throw fail(code, `${label} must be JSON serializable`);
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) {
    throw fail(code, `${label} exceeds the ${maxBytes}-byte limit`);
  }
  return encoded;
}

function audit({ serverId, toolId, toolName, argsHash, outcome, errorCode = '', startedAt }) {
  db.prepare(`
    INSERT INTO mcp_tool_execution_audit
      (id,server_id,tool_id,tool_name,arguments_sha256,outcome,error_code,duration_ms,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(randomUUID(), serverId, toolId, toolName, argsHash, outcome, errorCode, Math.max(0, now() - startedAt), now());
}

/**
 * Executes one already-approved tool through an injected, connected MCP SDK client.
 * This function is a policy gate, not a transport implementation or OS sandbox.
 */
export async function executeApprovedMcpTool({
  serverId, toolName, arguments: toolArguments = {}, client, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const startedAt = now();
  const server = getMcpServer(serverId);
  if (!server) throw fail('MCP_SERVER_NOT_FOUND', 'MCP server is not registered');
  if (server.status !== 'active') throw fail('MCP_SERVER_NOT_ACTIVE', 'MCP server must be active before tool execution');
  if (!client || typeof client.callTool !== 'function') throw fail('MCP_CLIENT_REQUIRED', 'A connected MCP SDK client with callTool() is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError('timeoutMs must be an integer between 100 and 120000');
  }
  if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)
    || (Object.getPrototypeOf(toolArguments) !== Object.prototype && Object.getPrototypeOf(toolArguments) !== null)) {
    throw fail('MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments must be a plain JSON object');
  }

  let argsEncoded;
  try {
    assertJsonSafe(toolArguments);
    argsEncoded = jsonBytes(toolArguments, 'MCP_INVALID_TOOL_ARGUMENTS', 'Tool arguments', MAX_ARGUMENT_BYTES);
  } catch (error) {
    audit({ serverId, toolId: 'unknown', toolName: String(toolName ?? '').slice(0, 160), argsHash: 'invalid', outcome: 'denied', errorCode: error.code || 'MCP_INVALID_TOOL_ARGUMENTS', startedAt });
    throw error;
  }
  const argsHash = createHash('sha256').update(argsEncoded).digest('hex');
  const tool = listMcpTools({ serverId, limit: 2000 }).find((item) => item.name === toolName);
  if (!tool || tool.policyStatus !== 'approved') {
    const error = fail('MCP_TOOL_NOT_APPROVED', 'Tool is missing or has not been explicitly approved');
    audit({ serverId, toolId: tool?.id ?? 'unknown', toolName: String(toolName ?? '').slice(0, 160), argsHash, outcome: 'denied', errorCode: error.code, startedAt });
    throw error;
  }

  let timer;
  try {
    const result = await Promise.race([
      client.callTool({ name: tool.name, arguments: JSON.parse(argsEncoded) }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('MCP_TOOL_EXECUTION_TIMEOUT', 'MCP tool execution exceeded its deadline')), timeoutMs);
      }),
    ]);
    jsonBytes(result, 'MCP_TOOL_RESULT_INVALID', 'Tool result', MAX_RESULT_BYTES);
    audit({ serverId, toolId: tool.id, toolName: tool.name, argsHash, outcome: 'success', startedAt });
    return result;
  } catch (error) {
    const timedOut = error?.code === 'MCP_TOOL_EXECUTION_TIMEOUT';
    audit({ serverId, toolId: tool.id, toolName: tool.name, argsHash, outcome: timedOut ? 'timeout' : 'failed', errorCode: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'MCP_TOOL_EXECUTION_FAILED', startedAt });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
