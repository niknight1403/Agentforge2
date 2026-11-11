# MCP Orchestration & Governance — Architecture

## Phase 1: Persistent registry and discovery contract

The first increment adds a durable SQLite registry to the existing VillaForge Hub runtime. It deliberately reuses the Hub's current `node:sqlite` database instead of introducing a second database or Prisma migration chain. The schema is forward-compatible with a later PostgreSQL adapter.

### Data model

- `mcp_servers`: server identity, transport definition (stdio/SSE/Streamable HTTP/WebSocket), auth mode plus opaque vault reference, lifecycle state, failure counters and health timestamps.
- `mcp_tools`: discovered tool name/description/input schema, capability tags, schema fingerprint and governance state.
- `mcp_registry_events`: transactional outbox for reliable publication to Redis Streams in the next increment.

Credentials are never stored inline. Authenticated definitions require an opaque `credentialRef`; secret-like keys in public config are rejected. Remote URLs reject unsupported schemes, embedded userinfo and fragments.

### Registry API

`registerMcpServer`, `updateMcpServer`, `getMcpServer`, `listMcpServers`, `setMcpServerStatus`, `removeMcpServer`, `replaceMcpServerTools`, `listMcpTools`, `setMcpToolPolicy` and outbox claim/ack functions are exported from `server/mcp-registry.mjs`.

Registry mutations and their outbox events are committed in the same SQLite transaction. Tool discovery is atomic. Input-schema fingerprints use recursively sorted object keys, so semantically identical schemas do not lose approval due to key ordering. Existing approval is retained only when the canonical input schema is unchanged; changed schemas return to `pending`. Capability metadata is validated before it is persisted. Tools absent from the latest `tools/list` snapshot are removed. This phase does not connect to arbitrary servers or execute tools.

### Planned phases

1. Registry/data model (this PR).
2. Transport adapters and startup handshake + `tools/list` verification.
3. Credential vault (AES-256-GCM), OAuth2 refresh and runtime-only injection.
4. Capability extraction, semantic query index and dynamic routing.
5. Supervisor, heartbeat, circuit breaker and exponential reconnect.
6. Governance policies, approval workflow, sandbox/rate limits and agent provisioning.
7. Redis Streams outbox publisher, observability, integration tests and operational runbooks.

### Security boundaries

- Registry writes are metadata-only; no network probing or subprocess launch is triggered by registration.
- Credential references are opaque identifiers; the vault is not part of this first phase.
- Newly discovered tools are pending by default and cannot be assumed agent-callable.
- No auto-approval is performed by this phase.
