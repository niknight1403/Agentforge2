import { getMcpServer, replaceMcpServerTools, setMcpServerStatus } from './mcp-registry.mjs';

const MAX_TOOLS = 500;
const MAX_SCHEMA_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inferCapabilities(name, description) {
  const text = `${name} ${description}`.toLowerCase();
  const rules = [
    ['filesystem', /file|directory|folder|filesystem|path/],
    ['network', /http|https|web|browser|fetch|url|network/],
    ['database', /sql|database|query|postgres|sqlite/],
    ['code', /code|repository|git|compile|build|test/],
    ['communication', /email|message|slack|discord|notification/],
    ['finance', /payment|invoice|stripe|billing|finance/],
    ['system', /process|shell|command|terminal|system/],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function normalizeDiscoveredTools(items) {
  if (!Array.isArray(items)) throw fail('MCP_INVALID_TOOLS_LIST', 'MCP tools/list did not return an array');
  if (items.length > MAX_TOOLS) throw fail('MCP_TOOL_LIMIT_EXCEEDED', `MCP server advertised more than ${MAX_TOOLS} tools`);
  const seen = new Set();
  return items.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw fail('MCP_INVALID_TOOL', 'MCP tools/list contains a non-object tool');
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name || name.length > 160 || seen.has(name)) throw fail('MCP_INVALID_TOOL_NAME', 'MCP tool names must be unique and contain 1..160 characters');
    seen.add(name);
    const description = typeof tool.description === 'string' ? tool.description : '';
    if (description.length > 4000) throw fail('MCP_TOOL_DESCRIPTION_TOO_LONG', `Description for ${name} exceeds 4000 characters`);
    const inputSchema = tool.inputSchema ?? { type: 'object', properties: {} };
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw fail('MCP_INVALID_TOOL_SCHEMA', `Input schema for ${name} must be a JSON object`);
    let schemaBytes;
    try { schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema)); } catch { throw fail('MCP_INVALID_TOOL_SCHEMA', `Input schema for ${name} is not JSON serializable`); }
    if (schemaBytes > MAX_SCHEMA_BYTES) throw fail('MCP_TOOL_SCHEMA_TOO_LARGE', `Input schema for ${name} exceeds 64 KiB`);
    return { name, description, inputSchema, capabilities: inferCapabilities(name, description) };
  });
}

export async function discoverMcpServerTools({ serverId, client, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const server = getMcpServer(serverId);
  if (!server) throw fail('MCP_SERVER_NOT_FOUND', 'MCP server is not registered');
  if (server.status === 'disabled') throw fail('MCP_SERVER_DISABLED', 'Disabled MCP servers cannot be discovered');
  if (!client || typeof client.listTools !== 'function') throw fail('MCP_CLIENT_REQUIRED', 'A connected MCP SDK client with listTools() is required');
  if (client.serverId !== serverId) throw fail('MCP_CLIENT_SERVER_MISMATCH', 'MCP discovery client must be bound to the requested registered server');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError('timeoutMs must be an integer between 100 and 120000');
  let timeout;
  try {
    const result = await Promise.race([
      client.listTools(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(fail('MCP_DISCOVERY_TIMEOUT', 'MCP tools/list timed out')), timeoutMs); }),
    ]);
    const normalized = normalizeDiscoveredTools(result?.tools);
    const persisted = replaceMcpServerTools(serverId, normalized);
    setMcpServerStatus(serverId, 'active');
    return { serverId, count: persisted.length, tools: persisted };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'MCP_DISCOVERY_FAILED';
    try { setMcpServerStatus(serverId, 'failed', { errorCode: code }); } catch { /* preserve discovery failure */ }
    if (code === 'MCP_DISCOVERY_TIMEOUT' && typeof client.close === 'function') {
      try { await client.close(); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
