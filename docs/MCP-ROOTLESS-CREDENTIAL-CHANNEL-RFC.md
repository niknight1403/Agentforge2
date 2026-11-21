# MCP Rootless Runner Credential Channel RFC

**Status:** Proposed — not approved for implementation or production use  
**Date:** 2026-11-21  
**Scope:** Authenticated MCP servers executed by the deployment-owned rootless Podman runtime

## 1. Current security boundary

The Hub credential vault stores credentials encrypted at rest with AES-256-GCM. The current Podman adapter intentionally rejects any server whose `authMode` is not `none` or which has a `credentialRef`, using `MCP_PODMAN_CREDENTIAL_CHANNEL_UNAVAILABLE`.

This fail-closed behavior is correct and MUST remain until this RFC is reviewed, implemented, tested adversarially, and independently security-reviewed. Vault encryption is not proof of safe delivery to a runner.

## 2. Threat model and invariants

Assume an MCP server process, its tools, tool output, and remote dependencies may be malicious. The Hub, vault, deployment-owned runner profile registry, pinned image digest, and credential broker are trusted components, subject to normal host compromise limitations.

The design MUST preserve these invariants:

- Plaintext credentials never appear in Podman CLI arguments, container environment variables, image layers, Podman inspect/config metadata, persistent files, shared writable mounts, logs, audit records, API responses, or error messages.
- The Hub master key and vault database are never mounted or exposed to the container.
- A credential is authorized for one registered server and one runtime instance only; no cross-server or cross-run access.
- Delivery is one-time, bounded, short-lived, and fail-closed. Replays, duplicate frames, malformed frames, wrong bindings, and expired capabilities are rejected.
- Stop, startup failure, crash, timeout, and forced removal close the delivery channel and revoke the capability.
- Only deployment-owned, immutable image digests and runner profiles may select the credential shim contract. Registry-provided commands, args, cwd, and arbitrary entrypoint overrides remain untrusted and unused.
- Existing unauthenticated rootless execution behavior remains unchanged.

## 3. Candidate transport: one-shot stdio bootstrap frame

A candidate approach is a versioned bootstrap frame sent over the already-attached Podman stdin stream before normal MCP JSON-RPC begins. This is a protocol proposal, not a transparent feature for arbitrary MCP images.

### Hub-side sequence

1. Authenticate the administrator and resolve the registered server, deployment-owned profile, immutable image digest, and runtime capacity.
2. Authorize the exact tuple `(serverId, runId, credentialRef, imageDigest, expiry)`.
3. Mint a cryptographically random, one-time capability bound to that tuple. Consume it atomically before delivery so concurrent starts cannot reuse it.
4. Decrypt the credential only immediately before launch. Keep plaintext in the narrowest possible in-memory scope; never include it in logged objects or thrown errors.
5. Send a strictly length-delimited, versioned bootstrap frame over the Podman stdin pipe. Enforce a small maximum frame size and an absolute delivery deadline.
6. After the frame is written, release Hub-side plaintext buffers best-effort and continue with the normal MCP stdio stream. Revoke the capability on every terminal path.

### Trusted image-side shim

Only images explicitly built and pinned for this contract may use it. Their trusted ENTRYPOINT shim MUST:

1. Read exactly one bounded bootstrap frame before launching the MCP child.
2. Validate protocol version, framing, expected server/run binding, expiry, and one-time nonce; reject truncation, trailing/duplicate frames, and replay.
3. Pass the credential to the child through a dedicated anonymous pipe/file descriptor, not argv, environment variables, or a file. The child must explicitly implement this FD contract.
4. Close the pipe after the one-time read and zero mutable buffers best-effort.
5. Start the MCP child without arbitrary registry-supplied command overrides, then forward normal MCP stdin/stdout without altering protocol bytes.
6. Terminate the child and close all descriptors on parent loss, timeout, malformed input, or shutdown. Disable core dumps where supported.

The credential itself MUST NOT be exposed through process arguments or environment variables. A fixed, documented descriptor number is acceptable only if the child reads the descriptor directly and no secret-bearing value is used as the descriptor selector.

### Compatibility

This protocol cannot authenticate arbitrary existing MCP images. A server image must implement the approved shim and child-FD consumer contract, or use a separately reviewed transport with equivalent guarantees. No generic fallback is permitted.

## 4. Why not environment variables or mounted secrets?

- Container environment variables are visible through process inspection and may be inherited or included in diagnostics.
- Podman CLI arguments and inspect/config metadata persist beyond the narrow delivery window.
- Mounting the Hub vault, master key, database, runtime socket, or a shared host secret directory breaks the per-server trust boundary.
- A generic persistent secret file creates lifecycle, cleanup, and host-forensics exposure that this design does not accept.

A future alternative such as an ephemeral memory-backed secret mount or Podman secret driver requires a separate threat model and independent review; it is not implicitly approved by this RFC.

## 5. Required authorization and lifecycle model

The credential broker MUST validate the complete binding on every delivery. The capability MUST be unpredictable, one-time, short-lived, and atomically consumed. It MUST NOT be accepted based solely on a client-supplied server ID or credential reference.

The broker MUST enforce:
- Admin-approved server registration and credential assignment.
- Per-server credential allowlisting and explicit auth mode.
- Per-runner image digest and profile binding.
- Bounded concurrent runtime capacity and delivery size/deadline.
- One successful delivery attempt at most.
- Revocation on failed start, stop, crash, runtime deadline, forced removal, credential deletion, or server disable/removal.

Audit data may contain opaque server/run/credential references, image digest, timestamps, and outcome codes. It MUST NOT contain plaintext, token fragments, bootstrap frames, or raw child diagnostics.

## 6. Adversarial acceptance tests

The implementation is not acceptable until tests prove all of the following against the real rootless Podman integration fixture:

1. Reject truncated, oversized, malformed, expired, duplicate, and replayed bootstrap frames.
2. Reject wrong server, run, image digest, credential reference, and cross-server/cross-run attempts.
3. Prove concurrent launches cannot race or consume the same one-time capability.
4. Prove the secret is absent from Podman argv, host/container environment, inspect/config output, logs, audit events, API responses, errors, image layers, persistent filesystem, and core dumps.
5. Prove only the intended child receives the one-time FD and cannot access another run's descriptor.
6. Prove hostile MCP tool output and exception paths cannot retrieve or echo bootstrap data.
7. Prove startup failure, timeout, crash, SIGTERM-resistant shutdown, forced removal, server disable/removal, and credential deletion revoke delivery and close descriptors.
8. Prove unauthenticated rootless MCP lifecycle tests remain unchanged and pass.
9. Include leak-scanning assertions over captured process arguments, environment, diagnostics, filesystem snapshots, and test logs.

## 7. Rollout gates

- RFC reviewed and approved by maintainers before implementation.
- Threat model and image-side shim contract reviewed.
- Unit tests plus hostile fixture tests pass.
- Real rootless Podman integration tests pass on the exact PR head.
- Independent security review has no unresolved critical/high findings.
- Production host/image compatibility and rollback plan documented.
- Authenticated MCP remains disabled until every gate is satisfied.

## 8. Explicit non-goals

This RFC does not authorize authenticated MCP today, change the current adapter guard, introduce arbitrary image commands, pass secrets through environment variables or CLI args, mount host credential stores, or claim production readiness.
