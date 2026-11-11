# MCP transport discovery phase

## SDK boundary

The Hub registry does not spawn processes or open sockets. A transport host is responsible for creating a connected client using the official MCP TypeScript SDK v2 (`@modelcontextprotocol/client`). The SDK's `Client.connect(transport)` performs the initialize handshake; `client.listTools()` retrieves advertised JSON Schema tool definitions. See the official client guide: https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-client.html.

This increment adds the post-connect discovery boundary in `server/mcp-transport-discovery.mjs`. It accepts an already-connected SDK-compatible client, validates and bounds the `tools/list` snapshot, infers conservative capability tags, persists the snapshot atomically through the registry, and marks the server active only after persistence succeeds. On discovery failure, the server is marked failed. A timed-out client is closed best-effort.

## Deliberate security boundary

This module does **not** construct a transport, resolve DNS, spawn stdio processes, inject credentials, or execute tools. No connection can occur until a separately reviewed transport host enforces destination allowlists, DNS/IP pinning against rebinding, redirect restrictions, TLS policy, stdio executable allowlists, argument policy, and OS/container sandboxing. Do not treat registry status `active` as permission to call tools; governance approval remains independent.

## Discovery limits

- 500 tools per server snapshot.
- Tool names are unique and limited to 160 characters.
- Descriptions are limited to 4,000 characters.
- Each input schema is limited to 64 KiB.
- Discovery timeout defaults to 15 seconds and is configurable between 100 ms and 120 seconds.
- Newly discovered tools remain `pending`; schema changes reset prior approval.
