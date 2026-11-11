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

The unit tests use fake SDK constructors to verify the adapter contract and lifecycle. A deployment still needs an integration test with its pinned official SDK version and a real, disposable MCP stdio server.

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
