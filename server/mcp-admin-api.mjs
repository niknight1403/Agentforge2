const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/;

function response(status, body) {
  return { status, body };
}

function publicServer(server) {
  if (!server) return null;
  const { credentialRef, config, args, url, ...safe } = server;
  const argumentCount = Array.isArray(args) ? args.length : 0;
  let publicUrl;
  if (typeof url === 'string' && url) {
    try {
      // Never return URL userinfo, path, query or fragment: remote endpoint
      // paths and query strings are frequently used to carry bearer tokens.
      publicUrl = new URL(url).origin;
    } catch {
      publicUrl = '[invalid URL redacted]';
    }
  }
  return {
    ...safe,
    ...(Array.isArray(args) ? { argumentCount } : {}),
    ...(publicUrl ? { url: publicUrl } : {}),
  };
}

function validateServerInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new TypeError('Request body must be an object'), { code: 'MCP_INVALID_REQUEST' });
  }
  const allowed = new Set([
    'name', 'transport', 'url', 'command', 'args', 'cwd', 'authMode', 'credentialRef', 'config',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw Object.assign(new TypeError(`Unsupported server field: ${key}`), { code: 'MCP_INVALID_REQUEST' });
    }
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) {
    throw Object.assign(new TypeError('name must contain 1..120 characters'), { code: 'MCP_INVALID_REQUEST' });
  }
  if (!['stdio', 'http', 'sse', 'websocket'].includes(input.transport)) {
    throw Object.assign(new TypeError('Unsupported MCP transport'), { code: 'MCP_INVALID_REQUEST' });
  }
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim()
      || typeof input.cwd !== 'string' || !input.cwd.trim()
      || !Array.isArray(input.args ?? []) || (input.args ?? []).length > 64
      || (input.args ?? []).some((arg) => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0'))) {
      throw Object.assign(new TypeError('stdio requires command, cwd and bounded string args'), { code: 'MCP_INVALID_REQUEST' });
    }
  } else if (typeof input.url !== 'string' || !input.url.trim()) {
    throw Object.assign(new TypeError('Remote transports require url'), { code: 'MCP_INVALID_REQUEST' });
  }
  return input;
}

/**
 * Framework-neutral, admin-only registry surface. The HTTP host must pass its
 * authenticated admin decision; this module never trusts request-supplied roles.
 * Runtime launch policy and SDK constructors remain server-owned dependencies
 * of the injected supervisor, never fields accepted from an API request.
 */
export function createMcpAdminApi({ registry, supervisor } = {}) {
  const requiredRegistryMethods = [
    'registerMcpServer', 'listMcpServers', 'getMcpServer', 'listMcpTools',
    'setMcpToolPolicy', 'setMcpServerStatus', 'removeMcpServer',
  ];
  if (!registry || requiredRegistryMethods.some((name) => typeof registry[name] !== 'function')
    || !supervisor || ['startServer', 'stopServer', 'getSnapshot'].some((name) => typeof supervisor[name] !== 'function')) {
    throw new TypeError('registry and supervisor dependencies are incomplete');
  }

  return async function handleMcpAdminRequest({ method, pathname, body, isAdmin = false } = {}) {
    if (!isAdmin) return response(403, { error: 'Administrator role required.' });
    if (typeof method !== 'string' || typeof pathname !== 'string') {
      return response(400, { error: 'method and pathname are required.' });
    }

    try {
      if (method === 'GET' && pathname === '/api/admin/mcp/servers') {
        const servers = registry.listMcpServers({ limit: 500 });
        return response(200, { servers: servers.map(publicServer), runtime: supervisor.getSnapshot() });
      }

      if (method === 'POST' && pathname === '/api/admin/mcp/servers') {
        const server = registry.registerMcpServer(validateServerInput(body));
        return response(201, { server: publicServer(server) });
      }

      const toolsMatch = /^\/api\/admin\/mcp\/servers\/([^/]+)\/tools$/.exec(pathname);
      if (method === 'GET' && toolsMatch) {
        const serverId = decodeURIComponent(toolsMatch[1]);
        if (!SERVER_ID.test(serverId)) return response(400, { error: 'Invalid server id.' });
        if (!registry.getMcpServer(serverId)) return response(404, { error: 'MCP server not found.' });
        return response(200, { tools: registry.listMcpTools({ serverId, limit: 2000 }) });
      }

      const lifecycleMatch = /^\/api\/admin\/mcp\/servers\/([^/]+)\/(start|stop|disable)$/.exec(pathname);
      if (lifecycleMatch && method === 'POST') {
        const serverId = decodeURIComponent(lifecycleMatch[1]);
        const action = lifecycleMatch[2];
        if (!SERVER_ID.test(serverId)) return response(400, { error: 'Invalid server id.' });
        const server = registry.getMcpServer(serverId);
        if (!server) return response(404, { error: 'MCP server not found.' });
        if (action === 'start') {
          if (server.transport !== 'stdio') return response(409, { error: 'Only stdio servers can currently be started.' });
          if (server.status === 'disabled') return response(409, { error: 'Disabled servers must be explicitly re-enabled before start.' });
          await supervisor.startServer(serverId);
          return response(202, { accepted: true, serverId, status: 'active' });
        }
        await supervisor.stopServer(serverId);
        if (action === 'disable') registry.setMcpServerStatus(serverId, 'disabled');
        return response(200, { stopped: true, serverId, status: action === 'disable' ? 'disabled' : 'pending' });
      }

      const policyMatch = /^\/api\/admin\/mcp\/tools\/([^/]+)\/policy$/.exec(pathname);
      if (policyMatch && method === 'POST') {
        const toolId = decodeURIComponent(policyMatch[1]);
        if (!TOOL_ID.test(toolId)) return response(400, { error: 'Invalid tool id.' });
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || !['approved', 'blocked', 'pending'].includes(body.policyStatus)
          || Object.keys(body).some((key) => !['policyStatus', 'reason'].includes(key))) {
          return response(400, { error: 'policyStatus must be approved, blocked or pending; optional reason only.' });
        }
        const tool = registry.setMcpToolPolicy(toolId, body.policyStatus, String(body.reason ?? '').slice(0, 500));
        return tool ? response(200, { tool }) : response(404, { error: 'MCP tool not found.' });
      }

      const removeMatch = /^\/api\/admin\/mcp\/servers\/([^/]+)$/.exec(pathname);
      if (removeMatch && method === 'DELETE') {
        const serverId = decodeURIComponent(removeMatch[1]);
        if (!SERVER_ID.test(serverId)) return response(400, { error: 'Invalid server id.' });
        if (!registry.getMcpServer(serverId)) return response(404, { error: 'MCP server not found.' });
        await supervisor.stopServer(serverId);
        registry.removeMcpServer(serverId);
        return response(200, { removed: true, serverId });
      }

      return response(404, { error: 'MCP administration endpoint not found.' });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code.slice(0, 120) : 'MCP_ADMIN_REQUEST_FAILED';
      const status = error?.code === 'MCP_RUNTIME_CAPACITY_REACHED' ? 409
        : error?.code === 'MCP_SERVER_NOT_FOUND' ? 404
          : error?.code === 'MCP_SERVER_DISABLED' ? 409
            : error?.code === 'MCP_LAUNCH_POLICY_NOT_CONFIGURED' ? 503
              : error?.code === 'MCP_SDK_NOT_INSTALLED' || error?.code === 'MCP_PROCESS_GROUP_UNSUPPORTED'
                || error?.code === 'MCP_PROCESS_GROUP_TERMINATION_UNCONFIRMED' ? 503 : 400;
      return response(status, { error: String(error?.message || 'MCP administration request failed').slice(0, 300), code });
    }
  };
}
