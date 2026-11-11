# MCP stdio runtime adapter

`server/mcp-stdio-runtime-adapter.mjs` turns the registry's stdio definition into a real SDK-managed child-process connection.

## Integration

Use the official MCP TypeScript SDK v2 client package (the current stable line) and inject its constructors so the host application controls the pinned SDK version:

```js
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectMcpStdioServer } from './mcp-stdio-runtime-adapter.mjs';

const adapter = await connectMcpStdioServer({
  serverId,
  policy: administratorOwnedStdioPolicy,
  Client,
  StdioClientTransport,
});
```

The adapter validates the registered executable, canonical working directory, argv, and environment before constructing the SDK transport. It returns a client facade bound to the registered `serverId`, compatible with the discovery and tool-execution gates. The caller must close the adapter when the server is disabled, removed, or the owning session ends.

For bearer-authenticated stdio servers, pass an explicit `credentialEnvKey` mapping. The credential is resolved from the encrypted vault only at connection time and is not written back to registry configuration. OAuth refresh is not supported by this adapter.

## Security boundary and limitations

- SDK constructors are injected; this module intentionally does not add or silently upgrade the repository's SDK dependency.
- The SDK transport owns child-process creation and teardown. Its stdio parameter contract does not expose a `shell` option; the SDK itself launches without a shell. SDK v2 merges a fixed set of host environment variables into every child even when `env` is supplied, so the adapter explicitly overrides those POSIX keys with empty values after policy validation. Windows is currently rejected because its inherited environment set needs a separate safe platform policy. Verify the exact SDK version in the deployment lockfile.
- The administrator must provide realpath-backed executable and sandbox allowlists, an environment-key allowlist, and a command-specific argv validator.
- This is not an OS sandbox. Use a dedicated low-privilege account/container, resource limits, read-only mounts, and network egress restrictions.
- Remote HTTP/SSE/WebSocket transports, DNS/socket pinning, redirect enforcement, OS/container isolation, resource quotas, crash restart policies, and OAuth are not implemented here.
- Do not expose the returned raw SDK client to untrusted callers. Use the facade's `listTools`, `callTool`, and `close` methods so the server binding remains intact.

The ordinary unit tests use fake SDK constructors to verify the adapter contract and lifecycle. The Hub-Tests workflow additionally installs the exact `@modelcontextprotocol/client@2.4.0` package without changing the repository lockfile and runs `server/tests/mcp-stdio-sdk-integration.test.mjs` against a disposable real stdio child process. This proves the adapter against that SDK release in CI; it does not yet make the SDK a production dependency. Before deployment, pin the chosen SDK in the Hub's production dependency manifest and lockfile, then rerun this integration test against that exact locked version.

## Registry-aware runtime supervision

`server/mcp-runtime-supervisor.mjs` owns connected stdio adapters and coordinates their lifecycle with the registry:

- Startup is explicit; pending servers are never launched automatically.
- Startup validates the adapter's server binding, performs tool discovery, and only retains the connection after discovery succeeds.
- Concurrent starts for the same server share one startup promise. A configurable concurrency cap (default: two) applies to starting, connected, and still-tearing-down runtimes.
- Stop requests cancel in-flight startup and close any late-arriving adapter. Close is idempotent at the supervisor boundary.
- `reconcile()` closes connected or starting runtimes whose registry entry was removed or disabled; it does not start pending servers.
- `closeAll()` is intended for orderly Hub shutdown.

Example:

```js
import { createMcpRuntimeSupervisor } from './mcp-runtime-supervisor.mjs';

const supervisor = createMcpRuntimeSupervisor({
  maxConcurrent: 2,
  connect: (options) => connectMcpStdioServer({
    ...options,
    policy: administratorOwnedStdioPolicy,
    Client,
    StdioClientTransport,
  }),
});

// Explicitly start a reviewed/registered server.
await supervisor.startServer(serverId);

// Invoke periodically from the Hub's existing lifecycle loop, and on shutdown:
await supervisor.reconcile();
await supervisor.closeAll();
```

This is an in-process lifecycle owner, not a hardened process supervisor. A production deployment still needs OS/container resource limits, crash detection/restart policy, and isolation outside Node.js.

### Lifecycle concurrency hardening

The supervisor serializes stop/restart for a given server. A restart requested while
the previous transport is closing waits for teardown and creates a fresh adapter;
it cannot receive the closing client. Duplicate stop requests share one teardown
operation. The runtime snapshot includes in-progress stops for operational visibility.

### Approved tool execution

The supervisor exposes `executeApprovedTool({ serverId, toolName, arguments, timeoutMs })`.
It refuses calls unless that server has a live adapter owned by this supervisor, then
delegates to the existing registry-backed `executeApprovedMcpTool` policy gate. The
raw client is not returned by this method. Tool approval, active registry status,
argument/result bounds, timeout handling, and execution audit remain enforced by
the existing execution gate.

The supervisor also provides `startReconciliationLoop({ intervalMs, onError })`
(default interval: 5 seconds, minimum: 100 ms). Reconciliation calls are single-flight
so slow registry operations cannot overlap. The returned stop function and
`stopReconciliationLoop()` stop polling; `closeAll()` stops the loop before teardown.
Call this explicitly from the Hub lifecycle after constructing the supervisor with
administrator-owned SDK constructors and launch policy.

Startup failures are persisted as registry status `failed` with a bounded error code
when the server still exists and the start was not cancelled. Discovery failures
already recorded by the discovery layer are not double-counted. Cancellation and
intentional disable/remove operations do not become false health failures.

If transport shutdown itself fails, the supervisor removes the adapter from the
usable connection map, records the server as `degraded` with an error code, and
propagates the teardown error to the caller. This avoids falsely reporting an
active runtime after its client has been detached.

Before closing a connected transport, the supervisor drains in-flight approved tool
executions for that server. New calls are rejected as soon as teardown begins.
This keeps a normal shutdown from killing an operation that already passed the
registry approval and audit gate. **Important:** the current execution timeout only
bounds how long the caller waits; `Promise.race` does not cancel the underlying SDK
`callTool()` operation. After a timeout, the underlying operation may still be running
while the supervisor releases its execution counter. Therefore this drain is best-effort,
not a hard shutdown bound. Do not treat it as safe process termination or enable this
runtime for untrusted workloads until the SDK transport exposes a verified cancellation
path or the child process can be terminated through an independently enforced supervisor.

Registry reconciliation pages through the complete registry (500 entries per page),
rather than relying on the registry's default first-page limit. Disabled or removed
servers beyond the first page are therefore still detected and closed.

## Hub integration status (release gate)

The supervisor and adapter are currently reusable runtime modules; they are **not wired into `server/server.mjs` startup or the existing `/api/mcp` JSON-RPC gateway**. The existing gateway still executes the Hub's built-in `TOOL_SPECS` through `runTool`; it does not route calls to registered external MCP servers. No registry-management API or administrator-owned launch-policy provider is connected yet. Consequently, a green unit/SDK integration test proves the module contract only, not an end-to-end Hub feature.

Before enabling this in production, implement and test the authenticated registry administration surface, inject a deployment-owned stdio launch policy, explicitly start/stop approved servers through the supervisor, route approved external tool calls through `executeApprovedTool`, expose sanitized runtime health, and close all runtimes during graceful Hub shutdown. Keep automatic startup disabled until an administrator explicitly approves a server. Add end-to-end tests covering authentication, approval, start/discovery, execution audit, disable/removal reconciliation, and shutdown.


## SDK-Auflösung im Runtime-Adapter

Der Adapter kann die offiziellen Konstruktoren selbst über `@modelcontextprotocol/client` und `@modelcontextprotocol/client/stdio` laden; Tests und kontrollierte Integrationen können weiterhin Konstruktoren injizieren. Fehlt das Paket, liefert der Adapter den stabilen Fehlercode `MCP_SDK_NOT_INSTALLED`. Diese Änderung ersetzt **nicht** die noch offene Produktionsabhängigkeit: Root-`package.json` und `package-lock.json` müssen gemeinsam mit einer reproduzierbaren npm-Lockfile-Generierung aktualisiert und mit `npm ci` validiert werden, bevor Hub-Startup den Adapter verwenden darf.
