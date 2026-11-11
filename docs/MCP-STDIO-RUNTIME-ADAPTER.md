# MCP stdio runtime adapter

`server/mcp-stdio-runtime-adapter.mjs` turns the registry's stdio definition into a real SDK-managed child-process connection.

## Integration

Inject the official MCP SDK constructors so the host application controls the pinned SDK version:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
- The SDK transport owns child-process creation and teardown. The adapter passes only validated argv and `shell: false` policy output.
- The administrator must provide realpath-backed executable and sandbox allowlists, an environment-key allowlist, and a command-specific argv validator.
- This is not an OS sandbox. Use a dedicated low-privilege account/container, resource limits, read-only mounts, and network egress restrictions.
- Remote HTTP/SSE/WebSocket transports, DNS/socket pinning, redirect enforcement, process supervision, and OAuth are not implemented here.
- Do not expose the returned raw SDK client to untrusted callers. Use the facade's `listTools`, `callTool`, and `close` methods so the server binding remains intact.

The unit tests use fake SDK constructors to verify the adapter contract and lifecycle. A deployment still needs an integration test with its pinned official SDK version and a real, disposable MCP stdio server.
