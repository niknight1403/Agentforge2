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
- Remote HTTP/SSE/WebSocket transports, DNS/socket pinning, redirect enforcement, process supervision, and OAuth are not implemented here.
- Do not expose the returned raw SDK client to untrusted callers. Use the facade's `listTools`, `callTool`, and `close` methods so the server binding remains intact.

The ordinary unit tests use fake SDK constructors to verify the adapter contract and lifecycle. The Hub-Tests workflow additionally installs the exact `@modelcontextprotocol/client@2.4.0` package without changing the repository lockfile and runs `server/tests/mcp-stdio-sdk-integration.test.mjs` against a disposable real stdio child process. This proves the adapter against that SDK release in CI; it does not yet make the SDK a production dependency. Before deployment, pin the chosen SDK in the Hub's production dependency manifest and lockfile, then rerun this integration test against that exact locked version.
