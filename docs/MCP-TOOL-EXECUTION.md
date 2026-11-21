# MCP tool execution gate

`server/mcp-tool-execution.mjs` is a narrow execution-policy boundary for an already-connected MCP SDK client.

- The server must be registered and in `active` lifecycle state.
- The named tool must exist in the persisted discovery snapshot and have explicit `approved` policy status. A schema change resets approval through the registry.
- Arguments must be a plain JSON object no larger than 64 KiB. Nested values reject custom prototypes, accessors, symbols, sparse/custom arrays, cycles, undefined, non-finite numbers, and other non-JSON values. The SDK result must be JSON-serializable and no larger than 1 MiB.
- Calls have a bounded deadline (100 ms–120 s; default 30 s).
- An append-only SQLite audit row records server/tool identifiers, SHA-256 of arguments, outcome, error code, and duration. Raw arguments, credentials, and tool results are not written to this audit table.
- The MCP client is injected; this module does not create transports, spawn processes, resolve DNS, enforce network pinning, or provide an OS/container sandbox.

## Integration contract

The caller must supply a connected, trusted MCP SDK client with a `serverId` property exactly matching the registered `serverId`; the gate rejects mismatches before invoking `callTool`. The property is an adapter contract, not cryptographic proof: only trusted adapter code may construct or pass clients. Do not reuse a client across tenants or credential scopes. A timeout does not prove that the remote operation was cancelled; adapters must implement cancellation/teardown and idempotency where supported. Tool approval is an explicit governance decision, not a guarantee that the remote server is benign. Apply least privilege and external sandbox/network controls before enabling untrusted servers.

## Agent tool discovery

The agent prompt may expose a dynamic alias `mcp:<serverId>:<toolName>` only while its registered server is active and that exact tool is explicitly approved. The alias is resolved again at execution time and still passes through the MCP runtime supervisor and execution-policy gate. The `mcp` tool pack and the project verification lock are enforced; all MCP calls are blocked while a source acceptance fingerprint is locked.

Enabled HTTPS JSON connectors may be exposed as `connector:<connectorId>:read`. Connector execution remains GET-only and uses the existing DNS/public-address checks, no-redirect behavior, bounded JSON response, and secret-reference handling.

MCP and connector arguments, outputs, and error details are omitted from the agent audit and trace; only bounded identifiers and argument counts are retained. Tool descriptions and outputs are untrusted data. The admin integration inventory is available at `GET /api/integrations`; it is admin-only and returns safe origins/status metadata, never secret values or full connector URLs.
