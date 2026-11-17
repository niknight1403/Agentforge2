# MCP per-server isolation — architecture decision record

Status: **Accepted design / implementation required before untrusted MCP execution**  
Scope: Agentforge2 MCP Hub, PR #162  
Decision owner: repository maintainers

## Context

The current Hub launches stdio MCP processes as POSIX process groups. Executable, working-directory, environment and exact argument allowlists reduce launch flexibility, and process-group teardown handles descendants. The optional Compose overlay hardens the Hub container as one unit.

Neither mechanism creates a security boundary between an MCP child and the Hub or between two MCP children. They share the Hub UID, network namespace, mounts (including writable application data), and container resource limits. A compromised MCP server could therefore attack the Hub, inspect accessible files, or reach network destinations available to the Hub. The shared-namespace acknowledgement is an operator warning/compatibility gate, not isolation.

## Decision

Untrusted MCP servers MUST NOT execute inside the Hub process/container. The Hub will retain registry, policy, approval, audit and orchestration responsibilities. Each stdio MCP server will execute in a separately provisioned, short-lived or supervised rootless runner with an independently enforced OS/container boundary.

The first supported production backend should be a local rootless container runtime (Podman preferred where available; rootless Docker may be supported only after equivalent capability tests). The runtime adapter must be explicit and deployment-configured. There is no silent fallback to in-process or shared-Hub execution.

## Required trust boundaries

1. **Hub control plane**
   - Stores server metadata and encrypted credential references.
   - Resolves a deployment-owned immutable server image/digest and policy profile.
   - Performs user/admin authorization, approval, tool policy, audit and quotas.
   - Never mounts the Hub's writable data volume into a runner.
   - Never passes the Docker/Podman socket, host root filesystem, host PID namespace, or Hub secrets wholesale to a runner.

2. **Per-server runner**
   - One isolated container/process sandbox per server instance; no shared writable filesystem between servers.
   - Non-root UID, read-only root filesystem, no-new-privileges, all Linux capabilities dropped, seccomp and AppArmor/SELinux profile where available.
   - Explicit read-only/read-write mounts from a dedicated per-server scratch/data directory only; no Hub database, source tree, credential vault, or general host paths.
   - PID, memory, CPU, file-size, open-file and wall-clock limits. Enforce limits outside the child process.
   - Network disabled by default. If network is required, apply a deployment-owned egress allowlist outside the container (host firewall/network policy); do not rely on a container flag alone. Deny loopback access to Hub/host services and cloud metadata endpoints.
   - Credentials are narrowly scoped, injected only for the server lifetime, never written to image layers or logs, and revoked/cleared on teardown.
   - Image is pinned by immutable digest and verified against deployment policy. No user-supplied arbitrary image or command in production.

3. **Hub ↔ runner channel**
   - Use a bounded, framed stdio stream over the runtime's attach API or a dedicated authenticated local broker.
   - Bound frame size, concurrent requests, pending queue, connection timeouts and tool-call deadlines.
   - Treat all runner output as untrusted data; validate JSON-RPC/MCP envelopes and tool schemas before returning results.
   - Never expose the container runtime socket to the MCP process.
   - On timeout, protocol violation, resource exhaustion or Hub shutdown: terminate the runner/container, verify it is gone, record an audit event, and fail the tool call closed.

## Provisioning contract

The runner backend should expose a narrow interface owned by the Hub:

- `create(server, deploymentProfile) -> { runnerId, stdin, stdout, stderrMetadata }`
- `terminate(runnerId, deadline) -> { terminated, exitCode, reason }`
- `inspect(runnerId) -> bounded operational metadata`

The backend must reject profiles that omit required isolation controls. It must not accept raw container arguments, host paths, environment variables, network settings or image references from registry/API input. All such values come from a validated deployment-owned profile. The server registry stores only a logical profile identifier.

## Fail-closed capability detection

Before enabling the backend, a startup self-test must verify the actual runtime and host capabilities required by the selected profile: rootless execution, non-root identity, read-only root, capability drop, no-new-privileges, seccomp/LSM availability as configured, resource limits, no Hub data mounts, network policy enforcement, and runtime socket non-exposure.

If a required control cannot be verified, the runner is unavailable and stdio start returns HTTP 503. There is no fallback to the existing process-group transport for untrusted servers. The existing shared-Hub acknowledgement remains restricted to explicitly trusted, operator-reviewed development servers and must not be represented as isolated.

## Acceptance tests (release blockers)

- Start two test MCP servers and prove their filesystem, process and writable scratch areas are mutually isolated.
- From a hostile test server, attempt to read Hub database/config/credential files, inspect other runner processes, access the runtime socket, reach Hub/host loopback, and reach cloud metadata; each attempt must fail.
- Verify default-deny egress and explicit allowlist behavior from outside the container.
- Verify non-root identity, read-only root, dropped capabilities, no-new-privileges, seccomp/LSM policy and resource limits from inside and outside the runner.
- Kill/timeout a runner with descendants and prove the complete container/cgroup is gone before reporting successful teardown.
- Verify oversized/malformed MCP frames, noisy stderr, output floods, fork bombs, memory exhaustion and CPU exhaustion cannot exhaust the Hub.
- Verify credentials are absent from logs, inspect output, image layers and post-teardown scratch.
- Run integration tests against the exact production runtime and kernel/host configuration; CI Compose rendering alone is insufficient.
- Obtain independent security review and retain target-environment evidence.

## Delivery sequence

1. Define and validate the deployment profile schema and runner backend interface.
2. Implement rootless runtime provisioning and inspect/terminate operations behind a disabled-by-default feature flag.
3. Add capability self-tests and fail-closed startup behavior.
4. Route the existing MCP stdio adapter through the runner's bounded streams; keep shared-Hub transport unavailable for untrusted profiles.
5. Add adversarial integration tests and deployment evidence.
6. Only after independent review, permit production enablement for approved profiles.

## Current status

This ADR records the required architecture; it does **not** claim that per-server isolation has been implemented. The current PR #162 process-group transport and Compose hardening remain defense-in-depth only. Untrusted MCP server execution remains blocked pending all acceptance tests and independent review.

## Implementation evidence (PR #162)

The current code is a fail-closed scaffold, not a connected per-server runtime:

- `mcp-podman-rootless-runner.mjs` builds a constrained Podman command and probes `podman info` for rootless mode.
- `mcp-podman-transport.mjs` can attach the image's configured ENTRYPOINT over stdio and attempts explicit container cleanup. It does not translate registry `command`, `args`, `cwd`, or `config` into an image contract, and it does not deliver a scoped credential from the MCP credential vault.
- `mcp-rootless-runner-profile.mjs` validates deployment-owned image/resource profiles, but `assertMcpRootlessRunnerAvailable()` intentionally returns `MCP_ROOTLESS_RUNNER_UNAVAILABLE` even when a probe callback is supplied.
- `mcp-hub-runtime.mjs` still wires only `connectMcpStdioServer` and requires the shared-Hub namespace acknowledgement. The runtime supervisor has no deployment-owned server-id-to-profile resolver or Podman transport selection.
- Current Podman transport tests inject a fake spawn function and fake successful rootless probe. They verify command construction and lifecycle behavior, not a real Podman daemon, kernel enforcement, or hostile-server isolation.

Consequently, a successful CI run validates the implemented code and its automated tests only. It does not satisfy the target-host integration or security acceptance criteria above. Do not enable `MCP_ROOTLESS_RUNNER_ENABLED` as a production readiness signal, and do not remove the shared-Hub fail-closed guard until the full image/config/credential contract, supervisor routing, real-runtime tests, and independent review are complete.
