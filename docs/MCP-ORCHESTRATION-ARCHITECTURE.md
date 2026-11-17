# MCP transport policy boundary

## Pre-connect policy helpers

`server/mcp-transport-policy.mjs` adds pure validation for the future transport host:

- stdio executable must be an exact administrator-allowlisted normalized absolute path;
- executable, working directory, and sandbox roots must be resolved through a trusted realpath function before allowlist comparison, preventing symlink escapes;
- working directory must remain inside an approved sandbox root after realpath resolution;
- arguments must be bounded and pass a command-specific validator;
- environment variables are allowlisted by key and bounded; credentials must be injected from the vault at runtime, never copied into registry configuration;
- remote URLs require an allowlisted hostname, secure HTTPS/WSS by default, an approved port, and a complete DNS answer set whose IP addresses are explicitly allowlisted;
- remote URL query parameters with credential-like names (`access_token`, `refresh_token`, `api_key`, `client_secret`, `password`, etc.) are rejected; use the registry's `credentialRef` and inject secrets only at connection time.

The stdio validator requires a trusted `realpath` callback (normally backed by `fs.realpathSync`) and compares canonical paths, not user-controlled symlink paths. The remote validator returns `pinnedAddresses`. A transport implementation MUST connect only to those exact addresses while retaining TLS hostname verification and the original Host/SNI value. Re-resolving the hostname at socket-connect time would reintroduce DNS-rebinding risk. Redirects must be disabled or every redirect target revalidated under the same policy.

## Important limitation

These functions validate policy inputs; they do not spawn processes, resolve DNS, pin sockets, inject secrets, or provide an OS sandbox. The future transport host must enforce those operations. For stdio, pass `shell: false` and isolate the process with OS/container controls, resource limits, and a read-only filesystem where possible. The returned policy result is not itself proof of sandboxing.

## Registry event outbox delivery

The SQLite outbox uses short-lived per-event claim tokens and leases. A worker claims a bounded batch in an immediate transaction; concurrent workers cannot claim the same unexpired event. Expired leases become eligible for retry and increment the attempt counter. Acknowledgement requires the matching claim token and an unexpired lease, preventing stale workers from acknowledging work reclaimed by another worker. Delivery remains at-least-once: consumers must be idempotent because a worker can publish successfully and crash before acknowledging.

The exported `dispatchMcpRegistryEvents({ publish })` helper provides the delivery loop without coupling the registry to a Redis client. It claims one event immediately before publishing, acknowledges only after the injected publisher resolves, and leaves failed events leased for retry after expiry. The publisher should use the event ID as its downstream idempotency key (for example, a Redis Stream field) to tolerate the unavoidable publish-before-ack crash window.
