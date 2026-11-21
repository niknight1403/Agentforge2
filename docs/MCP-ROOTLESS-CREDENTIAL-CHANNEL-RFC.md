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
- Delivery is one-time, bounded, short-lived, and fail-closed. The Hub atomically consumes the launch capability; the shim verifies a Hub signature over the complete launch binding. Replays, malformed frames, wrong bindings, and expired capabilities are rejected.
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

### Wire format and trust binding

The implementation MUST use a single normative encoding; the following is the proposed v1 contract:

- Frame prefix: 8-byte ASCII magic `AFMCPCRD`, unsigned 16-bit big-endian version (`1`), then unsigned 32-bit big-endian payload length.
- Payload: canonical CBOR map with exactly the required fields `serverId`, `runId`, `credentialRef`, `imageDigest`, `expiresAt`, `nonce`, `credential`, and `signature`. Reject unknown critical fields, duplicate map keys, non-canonical encodings, invalid UTF-8 identifiers, and any payload above a small fixed limit (proposed 16 KiB).
- Signature: Ed25519 over a domain-separated canonical encoding of every field except `signature`. The trusted shim contains only the corresponding Hub public verification key(s); it never contains a signing/private key. Key IDs and rotation overlap must be specified before implementation. The signature authenticates the metadata and credential as one indivisible envelope.
- The Hub broker remains the authorization authority: it validates the administrator-approved registration and credential assignment, binds the launch to the actual deployment-owned profile and image digest, and atomically consumes the unpredictable one-time capability before writing. The deployment-owned runner supplies non-secret expected `serverId`, `runId`, and immutable `imageDigest` values to the shim through a fixed, allowlisted launch-metadata contract (not registry-controlled values); the shim compares the signed envelope against those values. The runner—not an image-supplied field—establishes the actual immutable image digest used for launch. The shim does not independently authorize a credential; it trusts only a valid signature from the pinned Hub key after exact metadata comparison.
- Expiry uses an absolute Unix timestamp with a strict maximum lifetime; both Hub and shim reject expired envelopes. Clock-skew allowance must be explicit and bounded. Nonces are generated cryptographically and are single-use because each shim instance accepts exactly one bootstrap envelope; the Hub broker additionally prevents a capability from being issued/consumed twice.
- The shim reads the fixed prefix and exactly the declared payload length with a hard deadline. EOF before completion, unsupported versions, oversized lengths, signature failure, or parse failure abort startup. Bytes after that exact boundary belong to the MCP stdin stream; they are not interpreted as a second bootstrap frame. The MCP JSON-RPC parser must reject a second frame as invalid protocol input. The Hub writer MUST serialize the bootstrap frame before forwarding any client MCP bytes, so the boundary cannot race.
- The frame parser must never scan for a later magic marker or attempt resynchronization. A malformed bootstrap is fatal for that run. The deployment-owned runner's expected launch metadata is non-secret and may be visible in process/container metadata; it MUST never contain credential bytes or a capability.

This encoding is a design baseline, not permission to implement without maintainer approval and a reviewed cryptographic test vector.

### Trusted image-side shim

Only images explicitly built and pinned for this contract may use it. Their trusted ENTRYPOINT shim MUST:

1. Read exactly one bounded bootstrap frame before launching the MCP child.
2. Validate protocol version, framing, expiry, and the signed `serverId`, `runId`, and `imageDigest` against the non-secret expected launch metadata supplied by the deployment-owned runner; reject truncation, duplicate frames, and any binding mismatch. The Hub broker's atomic consume is the authoritative replay gate.
3. Verify the Ed25519 signature against the public key pinned in the trusted shim and validate the signed launch binding before releasing the credential. The shim MUST NOT trust unsigned frame fields or client-supplied launch metadata; expected metadata is supplied only by the deployment-owned runner.
4. Pass only the credential bytes to the intended child through a dedicated anonymous pipe/file descriptor, not argv, environment variables, or a file. Use close-on-exec by default and an explicit spawn file action to expose only the designated descriptor to the direct child; close every unrelated inherited descriptor.
5. The child contract MUST read the descriptor once and close it immediately, before spawning helpers or loading plugins. The descriptor MUST NOT be inherited by descendants. The shim closes its copy immediately after successful spawn and terminates the child on delivery failure. A malicious credential-consuming child can still disclose a credential it has legitimately received; this design protects delivery and unintended exposure, not a compromised recipient.
6. Start the MCP child without arbitrary registry-supplied command overrides, then forward normal MCP stdin/stdout without altering protocol bytes.
7. Terminate the child and close all descriptors on parent loss, timeout, malformed input, or shutdown. Disable core dumps where supported.

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

1. Verify canonical encoding and published Ed25519 test vectors; reject truncated, oversized, malformed, unsupported-version, invalid-signature, expired, duplicate, and replayed bootstrap frames.
2. Reject wrong server, run, image digest, credential reference, and cross-server/cross-run attempts, including tampered signed fields.
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
