import {
  getMcpServer,
  listMcpServers,
  setMcpServerStatus,
} from './mcp-registry.mjs';
import { discoverMcpServerTools } from './mcp-transport-discovery.mjs';
import { connectMcpStdioServer } from './mcp-stdio-runtime-adapter.mjs';
import { executeApprovedMcpTool } from './mcp-tool-execution.mjs';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Owns connected MCP runtimes and reconciles them with registry lifecycle state.
 * Pending servers are never auto-started; startup remains an explicit action.
 */
export function createMcpRuntimeSupervisor({
  connect = connectMcpStdioServer,
  discover = discoverMcpServerTools,
  getServer = getMcpServer,
  listServers = listMcpServers,
  setStatus = setMcpServerStatus,
  executeTool = executeApprovedMcpTool,
  maxConcurrent = 2,
} = {}) {
  if (typeof connect !== 'function' || typeof discover !== 'function'
    || typeof getServer !== 'function' || typeof listServers !== 'function'
    || typeof setStatus !== 'function' || typeof executeTool !== 'function') {
    throw new TypeError('connect, discover, getServer, listServers, setStatus and executeTool must be functions');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) {
    throw new TypeError('maxConcurrent must be an integer between 1 and 32');
  }

  const connections = new Map();
  const starting = new Map();
  const stopping = new Map();
  const cancelled = new Set();
  const activeExecutions = new Map();
  const executionDrainWaiters = new Map();
  let reconcileInFlight = null;
  let reconcileTimer = null;
  let reconciliationStop = null;

  function startServer(serverId, connectOptions = {}) {
    const id = String(serverId ?? '');
    if (!id) return Promise.reject(new TypeError('serverId is required'));
    if (stopping.has(id)) {
      return stopping.get(id).then(() => startServer(id, connectOptions));
    }
    if (connections.has(id)) return Promise.resolve(connections.get(id));
    if (starting.has(id)) return starting.get(id);

    const server = getServer(id);
    if (!server) return Promise.reject(fail('MCP_SERVER_NOT_FOUND', 'MCP server is not registered'));
    if (server.status === 'disabled') return Promise.reject(fail('MCP_SERVER_DISABLED', 'Disabled MCP servers cannot be started'));
    if (server.transport !== 'stdio') return Promise.reject(fail('MCP_TRANSPORT_UNSUPPORTED', 'This supervisor currently starts stdio servers only'));
    if (connections.size + starting.size + stopping.size >= maxConcurrent) {
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
        const failedServer = getServer(id);
        if (!cancelled.has(id) && failedServer
          && failedServer.status !== 'disabled' && failedServer.status !== 'failed') {
          try {
            setStatus(id, 'failed', {
              errorCode: typeof error?.code === 'string' ? error.code : 'MCP_RUNTIME_START_FAILED',
            });
          } catch { /* preserve the original startup failure */ }
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

  function stopServer(serverId) {
    const id = String(serverId ?? '');
    if (!id) return Promise.resolve(false);
    if (stopping.has(id)) return stopping.get(id);

    cancelled.add(id);
    const operation = (async () => {
      const pending = starting.get(id);
      if (pending) {
        try { await pending; } catch { /* startup owns teardown and its caller receives the failure */ }
      }
      const adapter = connections.get(id);
      if (!adapter) {
        const current = getServer(id);
        if (current?.status === 'active') setStatus(id, 'pending');
        return Boolean(pending);
      }
      // Remove it before awaiting close so a concurrent start cannot reuse a
      // client whose transport is already being torn down.
      connections.delete(id);
      const active = activeExecutions.get(id) ?? 0;
      if (active > 0) {
        await new Promise((resolve) => {
          const waiters = executionDrainWaiters.get(id) ?? [];
          waiters.push(resolve);
          executionDrainWaiters.set(id, waiters);
        });
      }
      try {
        await adapter.close();
      } catch (error) {
        const current = getServer(id);
        if (current && current.status !== 'disabled') {
          try {
            setStatus(id, 'degraded', {
              errorCode: typeof error?.code === 'string' ? error.code : 'MCP_RUNTIME_CLOSE_FAILED',
            });
          } catch { /* preserve the transport close failure */ }
        }
        throw error;
      }
      const current = getServer(id);
      if (current?.status === 'active') setStatus(id, 'pending');
      return true;
    })().finally(() => {
      cancelled.delete(id);
      stopping.delete(id);
    });
    stopping.set(id, operation);
    return operation;
  }

  async function executeApprovedTool({ serverId, toolName, arguments: toolArguments = {}, timeoutMs } = {}) {
    const id = String(serverId ?? '');
    const adapter = connections.get(id);
    if (!adapter || stopping.has(id)) throw fail('MCP_RUNTIME_NOT_CONNECTED', 'MCP server must have an active supervised runtime before tool execution');
    activeExecutions.set(id, (activeExecutions.get(id) ?? 0) + 1);
    try {
      return await executeTool({
        serverId: id, toolName, arguments: toolArguments, client: adapter,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } finally {
      const remaining = Math.max(0, (activeExecutions.get(id) ?? 1) - 1);
      if (remaining === 0) {
        activeExecutions.delete(id);
        const waiters = executionDrainWaiters.get(id) ?? [];
        executionDrainWaiters.delete(id);
        for (const resolve of waiters) resolve();
      } else {
        activeExecutions.set(id, remaining);
      }
    }
  }

  function listAllServers() {
    const servers = [];
    let offset = 0;
    while (true) {
      const page = listServers({ limit: 500, offset });
      if (!Array.isArray(page)) throw new TypeError('listServers must return an array');
      servers.push(...page);
      if (page.length < 500) return servers;
      offset += page.length;
    }
  }

  function reconcile() {
    if (reconcileInFlight) return reconcileInFlight;
    const operation = (async () => {
      const registered = new Map(listAllServers().map((server) => [server.id, server]));
      const stale = [...new Set([...connections.keys(), ...starting.keys()])]
        .filter((id) => !registered.has(id) || registered.get(id).status === 'disabled');
      const results = await Promise.allSettled(stale.map((id) => stopServer(id)));
      return {
        stopped: results.filter((item) => item.status === 'fulfilled' && item.value).length,
        failed: results.filter((item) => item.status === 'rejected').length,
        staleServerIds: stale,
      };
    })();
    reconcileInFlight = operation.finally(() => { reconcileInFlight = null; });
    return reconcileInFlight;
  }

  function stopReconciliationLoop() {
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    reconciliationStop = null;
  }

  function startReconciliationLoop({ intervalMs = 5_000, onError = () => {} } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 300_000) {
      throw new TypeError('intervalMs must be an integer between 100 and 300000');
    }
    if (typeof onError !== 'function') throw new TypeError('onError must be a function');
    if (reconcileTimer) return reconciliationStop;
    const tick = () => {
      reconcile().catch((error) => {
        try { onError(error); } catch { /* observer failures must not stop reconciliation */ }
      });
    };
    reconcileTimer = setInterval(tick, intervalMs);
    reconcileTimer.unref?.();
    reconciliationStop = stopReconciliationLoop;
    tick();
    return reconciliationStop;
  }

  async function closeAll() {
    stopReconciliationLoop();
    const ids = [...new Set([...connections.keys(), ...starting.keys(), ...stopping.keys()])];
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
    startReconciliationLoop,
    stopReconciliationLoop,
    closeAll,
    executeApprovedTool,
    getSnapshot() {
      return Object.freeze({
        connectedServerIds: [...connections.keys()],
        startingServerIds: [...starting.keys()],
        stoppingServerIds: [...stopping.keys()],
        reconciliationLoopRunning: Boolean(reconcileTimer),
        activeExecutions: Object.fromEntries(activeExecutions),
        maxConcurrent,
      });
    },
  });
}
