import {
  getMcpServer,
  listMcpServers,
} from './mcp-registry.mjs';
import { discoverMcpServerTools } from './mcp-transport-discovery.mjs';
import { connectMcpStdioServer } from './mcp-stdio-runtime-adapter.mjs';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Owns connected MCP runtimes and reconciles them with registry lifecycle state.
 *
 * The supervisor deliberately does not auto-start pending servers: starting a
 * process is an explicit action and still requires the caller's trusted SDK
 * constructors and administrator-owned launch policy. It does, however,
 * close runtimes when a server is disabled or removed.
 */
export function createMcpRuntimeSupervisor({
  connect = connectMcpStdioServer,
  discover = discoverMcpServerTools,
  getServer = getMcpServer,
  listServers = listMcpServers,
  maxConcurrent = 2,
} = {}) {
  if (typeof connect !== 'function' || typeof discover !== 'function'
    || typeof getServer !== 'function' || typeof listServers !== 'function'\n    || typeof setStatus !== 'function') {
    throw new TypeError('connect, discover, getServer, listServers and setStatus must be functions');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) {
    throw new TypeError('maxConcurrent must be an integer between 1 and 32');
  }

  const connections = new Map();
  const starting = new Map();
  const cancelled = new Set();

  function startServer(serverId, connectOptions = {}) {
    const id = String(serverId ?? '');
    if (!id) return Promise.reject(new TypeError('serverId is required'));
    if (connections.has(id)) return Promise.resolve(connections.get(id));
    if (starting.has(id)) return starting.get(id);

    const server = getServer(id);
    if (!server) return Promise.reject(fail('MCP_SERVER_NOT_FOUND', 'MCP server is not registered'));
    if (server.status === 'disabled') return Promise.reject(fail('MCP_SERVER_DISABLED', 'Disabled MCP servers cannot be started'));
    if (server.transport !== 'stdio') return Promise.reject(fail('MCP_TRANSPORT_UNSUPPORTED', 'This supervisor currently starts stdio servers only'));
    if (connections.size + starting.size >= maxConcurrent) {
      return Promise.reject(fail('MCP_RUNTIME_CAPACITY_REACHED', 'MCP runtime concurrency limit has been reached'));
    }

    cancelled.delete(id);
    const pending = (async () => {
      let adapter;
      try {
        adapter = await connect({ ...connectOptions, serverId: id });
        if (!adapter || adapter.serverId !== id || typeof adapter.close !== 'function'
          || typeof adapter.listTools !== 'function' || typeof adapter.callTool !== 'function') {
          throw fail('MCP_RUNTIME_ADAPTER_INVALID', 'Runtime adapter must expose the matching serverId, listTools, callTool and close');
        }
        const current = getServer(id);
        if (cancelled.has(id) || !current || current.status === 'disabled') {
          throw fail('MCP_RUNTIME_START_CANCELLED', 'MCP server was disabled, removed or stopped while starting');
        }
        await discover({ serverId: id, client: adapter });
        const afterDiscovery = getServer(id);
        if (cancelled.has(id) || !afterDiscovery || afterDiscovery.status === 'disabled') {
          throw fail('MCP_RUNTIME_START_CANCELLED', 'MCP server lifecycle changed during discovery');
        }
        connections.set(id, adapter);
        return adapter;
      } catch (error) {
        if (adapter) {
          try { await adapter.close(); } catch { /* preserve the startup failure */ }
        }
        throw error;
      } finally {
        starting.delete(id);
        cancelled.delete(id);
      }
    })();
    starting.set(id, pending);
    return pending;
  }

  async function stopServer(serverId) {
    const id = String(serverId ?? '');
    if (!id) return false;
    cancelled.add(id);
    const pending = starting.get(id);
    if (pending) {
      try { await pending; } catch { /* startup owns teardown and its caller receives the failure */ }
    }
    const adapter = connections.get(id);
    if (!adapter) {
      cancelled.delete(id);
      return Boolean(pending);
    }
    connections.delete(id);
    try {
      await adapter.close();
    } finally {
      cancelled.delete(id);
    }
    return true;
  }

  async function reconcile() {
    const registered = new Map(listServers().map((server) => [server.id, server]));
    const stale = [...new Set([...connections.keys(), ...starting.keys()])]
      .filter((id) => !registered.has(id) || registered.get(id).status === 'disabled');
    const results = await Promise.allSettled(stale.map((id) => stopServer(id)));
    return {
      stopped: results.filter((item) => item.status === 'fulfilled' && item.value).length,
      failed: results.filter((item) => item.status === 'rejected').length,
      staleServerIds: stale,
    };
  }

  async function closeAll() {
    const ids = [...new Set([...connections.keys(), ...starting.keys()])];
    const results = await Promise.allSettled(ids.map((id) => stopServer(id)));
    return {
      closed: results.filter((item) => item.status === 'fulfilled' && item.value).length,
      failed: results.filter((item) => item.status === 'rejected').length,
    };
  }

  return Object.freeze({
    startServer,
    stopServer,
    reconcile,
    closeAll,
    getSnapshot() {
      return Object.freeze({
        connectedServerIds: [...connections.keys()],
        startingServerIds: [...starting.keys()],
        maxConcurrent,
      });
    },
  });
}
