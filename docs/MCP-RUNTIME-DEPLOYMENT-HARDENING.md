# MCP runtime deployment hardening baseline

This runbook covers the Agentforge2 MCP Hub's deployment-owned, rootless Podman runtime. It describes the current fail-closed implementation and the remaining rollout gates; it is not proof of a production deployment or an independent security certification.

## Release prerequisites

Do not enable an MCP server until all applicable conditions are true:

- The Hub uses the pinned official `@modelcontextprotocol/client@2.4.0` production dependency and npm-generated lockfile. A clean `npm ci` and real-SDK stdio integration test pass against that lockfile.
- The deployment maps each immutable registered server UUID to exactly one administrator-owned runner profile. Registry fields never choose an image, executable, command, arguments, environment, mounts, or network policy.
- The image is pinned by immutable `sha256` digest and is reviewed as an MCP stdio server. The Podman backend is rootless and passes its runtime capability probe.
- The profile requires `network=none`, a read-only root filesystem, dropped capabilities, no-new-privileges, a non-root container user, bounded memory/CPU/PIDs/runtime, no Hub data mounts, and no container-runtime socket.
- Registry administration is behind the Hub's existing session/API-token authentication and administrator-role check. The HTTP API cannot supply or override deployment policy.
- Servers remain pending until an administrator explicitly starts them. Tools require separate explicit approval and every approved call passes through the registry-backed audit gate.
- The Hub closes managed runtimes on graceful shutdown and the deployment has staging evidence for stop, crash, timeout, and cleanup behavior.
- A security review and end-to-end lifecycle review have no unresolved critical or high findings.

Authenticated MCP servers remain blocked until a scoped credential channel into isolated containers is implemented and tested. Remote HTTP/SSE/WebSocket transports are registry-only and are not executed. There is no fallback to a shared-Hub process namespace when a rootless profile or Podman capability is missing.

## Dedicated Linux service identity

Run the Hub under a dedicated unprivileged account. Do not run it as root or share its identity with unrelated workloads. The account should have:

- Read/execute access only to the Hub release and required runtime binaries.
- Write access only to the Hub's required state, log, and temporary directories.
- No interactive shell, SSH key, or broad home-directory access.
- No access to host credentials, unrelated application data, or privileged container-runtime sockets.

Rootless Podman must run as this unprivileged account with correctly provisioned subordinate UID/GID ranges and a private runtime directory. Do not grant the Hub account passwordless root or a privileged Podman socket.

## Rootless Podman profile contract

The profile is selected by the registered server UUID from deployment-owned configuration. It is not accepted from the registry request or administrator API payload. Validate the profile before use and keep the image digest immutable.

The runner must enforce all of the following:

- Rootless Podman only; fail closed when the capability probe fails.
- No network namespace connectivity (`--network=none`).
- Read-only container root, no-new-privileges, dropped Linux capabilities, and a non-root container UID.
- Explicit memory, CPU quota, PID-count, and runtime-deadline bounds.
- No host data mounts, no Hub source/state mounts, and no runtime socket.
- A server image whose configured entrypoint speaks the MCP stdio protocol. Registry host commands and arguments are not passed into the container.
- Authenticated registrations are rejected until a scoped secret-delivery protocol exists. Never place secrets in Podman CLI arguments, container environment, image layers, logs, or shared mounts.

The real Linux CI integration suite exercises a disposable rootless Podman image through initialize, tools/list, tools/call, independent per-server containers, crash cleanup, and forced removal of a SIGTERM-resistant container. It also verifies that a pending MCP request is rejected when the runtime is forcibly retired. This is CI evidence, not a substitute for staging validation on the target host and distribution.

## systemd hardening template

The following is a **template**, not a drop-in that can be copied unchanged. Replace every path and resource limit after measuring the actual Hub workload. Confirm that required SQLite/database, build, and temporary paths remain writable before rollout.

```ini
[Service]
User=villaforge
Group=villaforge
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077

# Explicit writable paths only; replace with paths verified for this install.
ReadWritePaths=/srv/villaforge/data /srv/villaforge/logs /srv/villaforge/tmp

# Bound the Hub and its control processes as one service cgroup.
MemoryMax=2G
CPUQuota=200%
TasksMax=128
KillMode=control-group
TimeoutStopSec=30
SendSIGKILL=yes
```

Systemd directives vary by distribution and version. Validate the unit with `systemd-analyze verify`, then test restart, graceful shutdown, and forced termination in a staging environment. The resource values above are examples, not measured recommendations.

## Network, filesystem, and image policy

- Keep runner profiles administrator-owned and keyed to immutable server IDs. Do not allow a registry user to select an image or alter resource/isolation settings.
- Use only reviewed images pinned by digest. Rebuild and review images before updating a digest.
- Keep Hub credentials, writable state, source code, and container-runtime sockets outside the MCP container.
- Keep outbound networking disabled by default. If a future transport needs network access, implement a separate reviewed egress policy and address-pinning/redirect controls; do not weaken the rootless profile silently.
- Do not treat an in-process Promise timeout as proof that an external side effect was cancelled. A process can perform an irreversible external action before it is terminated.

## Shutdown and timeout semantics

The rootless Podman transport owns a named container and explicitly removes it during close. When the deployment-owned runtime deadline expires, the transport notifies the SDK that the connection is closed and force-removes the container; in-flight SDK requests are rejected instead of remaining pending. The Linux integration test verifies this with a fixture that ignores SIGTERM and confirms that no MCP container remains.

A tool timeout still does not roll back external side effects already performed by a server. Callers must use idempotency where available and treat timeout outcomes as potentially indeterminate for remote systems. If container removal cannot be confirmed, surface a cleanup failure and keep the server unavailable; never fall back to shared-Hub execution.

## Rollout checklist

1. Validate rootless Podman, subordinate UID/GID ranges, storage, and service identity on the target Linux host.
2. Confirm the Hub starts with zero external MCP containers.
3. Create one reviewed immutable image and one deployment-owned profile keyed to a registered server UUID.
4. Register the server in pending state; confirm it is not auto-started.
5. Approve its tools separately, then explicitly start the server as an administrator.
6. Verify initialize, tools/list, and an approved tools/call; confirm network is disabled and no host mounts or runtime socket are present.
7. Exercise stop, crash, runtime deadline, and SIGTERM-resistant cleanup; verify the container is removed and pending calls reject.
8. Disable and remove the server; verify the runtime remains stopped.
9. Restart the Hub and verify no pending server auto-starts.
10. Capture test output, image digest, profile mapping, host configuration, and security-review findings as release evidence.

Until the deployment profile, target-host validation, and security review are complete, keep untrusted and authenticated MCP servers blocked. The current implementation is fail-closed and has not been deployed or released by this change.
