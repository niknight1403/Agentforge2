import process from 'node:process';
import { getMcpServer } from './mcp-registry.mjs';
import { readMcpCredential } from './mcp-credential-vault.mjs';
import { validateStdioLaunch } from './mcp-transport-policy.mjs';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
// SDK v2 merges these host variables into every stdio child even when env is supplied.
const SDK_INHERITED_ENV_KEYS = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs, code, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(code, message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Creates a real stdio MCP connection using constructors from the official
 * MCP SDK. SDK constructors are injected so the Hub can select and pin its
 * SDK major version independently of this security boundary.
 *
 * This is process-launch hardening, not an OS sandbox. Run the Hub with a
 * dedicated low-privilege account and enforce filesystem/network isolation
 * outside Node.js.
 */
export async function connectMcpStdioServer({
  serverId,
  policy,
  Client,
  StdioClientTransport,
  loadSdk = async () => {
    const [clientSdk, stdioSdk] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/client/stdio'),
    ]);
    return {
      Client: clientSdk.Client,
      StdioClientTransport: stdioSdk.StdioClientTransport,
    };
  },
  clientInfo = { name: 'agentforge2-hub', version: '1.0.0' },
  credentialEnvKey,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  const server = getMcpServer(serverId);
  if (!server) throw fail('MCP_SERVER_NOT_FOUND', 'MCP server is not registered');
  if (server.transport !== 'stdio') throw fail('MCP_TRANSPORT_MISMATCH', 'Only registered stdio servers can use this adapter');
  if (server.status === 'disabled') throw fail('MCP_SERVER_DISABLED', 'Disabled MCP servers cannot be connected');
  if (typeof loadSdk !== 'function') throw new TypeError('loadSdk must be a function');
  if (Client === undefined || StdioClientTransport === undefined) {
    let sdk;
    try {
      sdk = await loadSdk();
    } catch {
      throw fail('MCP_SDK_NOT_INSTALLED', 'Install the pinned @modelcontextprotocol/client production dependency');
    }
    Client ??= sdk?.Client;
    StdioClientTransport ??= sdk?.StdioClientTransport;
  }
  if (typeof Client !== 'function' || typeof StdioClientTransport !== 'function') {
    throw fail('MCP_SDK_CONSTRUCTORS_REQUIRED', 'The official MCP SDK must provide Client and StdioClientTransport constructors');
  }
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 120_000) {
    throw new TypeError('connectTimeoutMs must be an integer between 100 and 120000');
  }

  if (process.platform === 'win32') {
    throw fail('MCP_STDIO_PLATFORM_UNSUPPORTED', 'Windows stdio is disabled until SDK inherited environment variables can be isolated safely');
  }

  const configuredEnv = server.config?.env ?? {};
  if (!configuredEnv || typeof configuredEnv !== 'object' || Array.isArray(configuredEnv)) {
    throw fail('MCP_INVALID_ENV', 'Registered stdio config.env must be an object');
  }
  const env = { ...configuredEnv };
  if (server.authMode === 'bearer') {
    if (typeof credentialEnvKey !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnvKey)) {
      throw fail('MCP_CREDENTIAL_ENV_KEY_REQUIRED', 'Bearer stdio credentials require an explicit environment variable mapping');
    }
    if (Object.hasOwn(env, credentialEnvKey)) {
      throw fail('MCP_CREDENTIAL_ENV_COLLISION', 'Credential environment variable must not be configured in registry data');
    }
    const credential = readMcpCredential(server.credentialRef);
    if (typeof credential !== 'string' || !credential) {
      throw fail('MCP_CREDENTIAL_NOT_FOUND', 'The registered credential reference could not be resolved');
    }
    env[credentialEnvKey] = credential;
  } else if (server.authMode !== 'none') {
    throw fail('MCP_AUTH_MODE_UNSUPPORTED', 'This stdio adapter currently supports none and bearer authentication only');
  }

  let launch;
  try {
    launch = validateStdioLaunch({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env,
    }, policy);
  } finally {
    // Keep the decrypted secret only in the validated launch copy.
    if (credentialEnvKey && Object.hasOwn(env, credentialEnvKey)) delete env[credentialEnvKey];
  }

  // SDK v2 merges host defaults into the child env. Override every inherited
  // POSIX key so host identity, PATH and environment values are not leaked.
  for (const key of SDK_INHERITED_ENV_KEYS) launch.env[key] = '';

  let transport;
  let client;
  let closed = false;
  let closePromise;
  const close = () => {
    // Concurrent callers share one teardown operation and observe its result.
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      let clientCloseError;
      try {
        if (client && typeof client.close === 'function') {
          try {
            await client.close();
          } catch (error) {
            clientCloseError = error;
            // A failed SDK close must not prevent a best-effort transport teardown.
            if (transport && typeof transport.close === 'function') {
              try { await transport.close(); } catch { /* preserve the SDK close error */ }
            }
          }
        } else if (transport && typeof transport.close === 'function') {
          await transport.close();
        }
      } finally {
        // Do not retain a decrypted credential in this adapter's launch object.
        for (const key of Object.keys(launch.env)) {
          if (key === credentialEnvKey) delete launch.env[key];
        }
      }
      if (clientCloseError) throw clientCloseError;
    })();
    return closePromise;
  };

  try {
    transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
    });
    client = new Client(clientInfo);
    await withTimeout(
      client.connect(transport),
      connectTimeoutMs,
      'MCP_CONNECT_TIMEOUT',
      'MCP stdio connection exceeded its deadline',
    );
    return Object.freeze({
      serverId,
      transport: 'stdio',
      async listTools() {
        if (closed) throw fail('MCP_CLIENT_CLOSED', 'MCP stdio client is closed');
        return client.listTools();
      },
      async callTool(params) {
        if (closed) throw fail('MCP_CLIENT_CLOSED', 'MCP stdio client is closed');
        return client.callTool(params);
      },
      close,
    });
  } catch (error) {
    try { await close(); } catch { /* preserve the connection failure */ }
    if (error?.code) throw error;
    throw fail('MCP_CONNECT_FAILED', 'MCP stdio connection failed');
  }
}
