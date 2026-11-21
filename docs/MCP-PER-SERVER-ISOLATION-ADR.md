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

## Current status — re-audited 2026-11-21

Per-server rootless Podman routing is now wired in the default-branch code. This is an implemented execution path for unauthenticated stdio MCP images, but it is not blanket production approval for arbitrary registry servers.

## Implementation evidence

- `server/mcp-hub-runtime.mjs` resolves a deployment-owned profile by registered server UUID and routes supervisor connections through `connectMcpPodmanServer`. It does not fall back to shared-Hub stdio.
- `server/mcp-rootless-profile-registry.mjs` validates a bounded deployment-owned UUID-to-profile mapping. It rejects unknown profile fields and requires an immutable image digest and the required isolation/resource settings.
- `server/mcp-podman-rootless-runner.mjs` builds a shell-free Podman invocation with rootless mode, no network, read-only root, dropped capabilities, no-new-privileges, non-root UID, and bounded memory/CPU/PIDs/runtime.
- `server/mcp-podman-runtime-adapter.mjs` connects the pinned MCP SDK to the image ENTRYPOINT over stdio. Registry command/args/cwd/config are not passed into the container.
- `server/mcp-runtime-supervisor.mjs` owns bounded start/stop, execution admission, drain, reconciliation and cleanup fencing.
- The adapter deliberately rejects authenticated registrations (`authMode !== 'none'` or a credential reference) with `MCP_PODMAN_CREDENTIAL_CHANNEL_UNAVAILABLE`. No credential is passed to Podman. Authenticated MCP remains disabled until a scoped secret channel is designed and verified.
- The real-runtime test `server/tests/mcp-podman-rootless.integration.test.mjs` covers initialize/listTools/callTool, independent per-server containers, crash cleanup and forced removal after a SIGTERM-resistant runtime deadline.

## CI evidence and limitations

MCP Runtime Integration workflow run `44025936286` on commit `129c4015ec69cc7d068bb6ddc75723d09fec333f` completed successfully. Both `mcp-runtime` and `mcp-rootless-podman` jobs passed. The latter installed Podman on Linux, verified rootless mode, built the disposable fixture image and ran the integration suite against the actual Podman runtime. This is real runtime CI evidence, not mocked spawn/probe evidence.

That run is not on the current default-branch head `0140191ead8f72dd03308ea8c2dc170744a0de70`. The workflow's pull-request target filter now includes `main` so a future MCP change PR targeting the default branch will execute the real-Podman job. A fresh exact-head run is still required for a final release decision.

## Remaining release blockers

1. Implement and adversarially test a scoped credential channel for authenticated MCP servers. Never place secrets in Podman CLI args, container environment, logs, image layers, shared mounts or host-visible plaintext files.
2. Run the real rootless Podman workflow on the final intended code head and retain its logs/artifacts.
3. Verify the deployment's actual rootless Podman/kernel configuration and production image compatibility; the fixture image is not proof that every registry image obeys the expected stdio contract.
4. Update/retain independent security review evidence and resolve all high/critical findings before enabling untrusted workloads.
5. Keep remote HTTP/SSE/WebSocket execution disabled unless a separate transport-specific security model is implemented and reviewed.

A green CI run validates only the exact commit and tests exercised. It does not establish production deployment, arbitrary image compatibility, secure authenticated MCP credentials, or independent security certification. Do not enable authenticated or untrusted MCP servers until the remaining release blockers are satisfied.
