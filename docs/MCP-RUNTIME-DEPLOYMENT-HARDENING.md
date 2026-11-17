# MCP runtime deployment hardening baseline

This runbook is an operator baseline for the stdio runtime described in
[MCP-STDIO-RUNTIME-ADAPTER.md](./MCP-STDIO-RUNTIME-ADAPTER.md). It is not an
OS sandbox implementation and does not make the current Hub integration
production-ready by itself.

## Release prerequisites

Do not enable external MCP server execution until all of these are true:

- The exact official SDK version is a production dependency in the root
  `package.json` and npm-generated `package-lock.json`; a clean `npm ci`
  and real-SDK stdio integration test pass against that lockfile.
- The Hub constructs the supervisor with a deployment-owned launch policy.
  Registry values are untrusted input and must never define their own allowlist.
- Registry administration and lifecycle actions are authenticated and
  administrator-authorized. Tool approval is separate from server registration.
- External calls pass through the registry approval and audit gate. Raw SDK
  clients, decrypted credentials, and process handles are never returned by
  HTTP handlers.
- The Hub exposes sanitized health and closes every managed runtime on graceful
  shutdown. Startup remains opt-in; pending registry entries are never launched
  automatically.
- The deployment has process isolation, bounded resources, restricted
  filesystem access, and explicit network egress policy.
- A security review and end-to-end lifecycle tests have no unresolved critical
  or high findings.

## Dedicated Linux service identity

Run the Hub under a dedicated unprivileged account. Do not run it as root and
do not share its identity with unrelated workloads. The account should have:

- Read/execute access only to the Hub release and approved MCP executables.
- Write access only to the Hub's required state, log, and temporary directories.
- No interactive shell, SSH key, or broad home-directory access.
- No access to host credentials, container runtime sockets, or unrelated
  application data.

Keep approved MCP working directories separate from the Hub source tree. Make
them writable only when a specific server requires it; prefer read-only mounts.

## systemd hardening template

The following is a **template**, not a drop-in that can be copied unchanged.
Replace every path and resource limit after measuring the actual Hub workload.
Confirm that required SQLite/database, build, and temporary paths remain
writable before rollout.

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

# Bound the Hub and all stdio child processes as one service cgroup.
MemoryMax=2G
CPUQuota=200%
TasksMax=128
KillMode=control-group
TimeoutStopSec=30
SendSIGKILL=yes
```

Systemd directives vary by distribution and version. Validate the unit with
`systemd-analyze verify`, then test restart, graceful shutdown, and forced
termination in a staging environment. The resource values above are examples,
not measured recommendations.

## Child-process and network policy

- Keep the executable allowlist administrator-owned and based on resolved
  realpaths. Do not allow shells, interpreters, package managers, or generic
  command launchers unless a reviewed server specifically requires them.
- Use command-specific argument validators. A path allowlist alone is not
  sufficient when arguments can select arbitrary files, plugins, scripts, or
  network destinations.
- Use per-server working directories and minimal environment-key allowlists.
  Inject credentials from the encrypted vault at launch time; never store
  secret values in registry JSON or logs.
- Apply outbound network policy outside Node.js (host firewall, dedicated
  container/network namespace, or an egress proxy). Default-deny outbound
  traffic and allow only the destinations required by that MCP server.
- Do not treat DNS validation as socket pinning. A transport must connect to
  the validated address set and reject redirects or address changes that escape
  policy. The current stdio adapter does not implement remote transports.
- Set per-server CPU, memory, process-count, file-descriptor, and execution-time
  limits at the OS/container layer. An in-process Promise timeout is not a
  process-kill guarantee.

## Shutdown and timeout semantics

The supervisor drains approved calls before normal transport teardown. A tool
execution timeout currently bounds the caller's wait and retires the stdio
runtime, but JavaScript `Promise.race` does not cancel the underlying SDK
request. Transport close alone is not proof that the child process has exited.

Before enabling untrusted workloads, add and verify an explicit child-process
termination strategy (including process-group/cgroup ownership), cancellation
propagation, bounded shutdown, and an observable confirmation that every child
has exited. Test a deliberately hung MCP server and a child that spawns
grandchildren. The test must prove no process survives stop, timeout, Hub
shutdown, or forced service restart.

## Rollout checklist

1. Validate the unit and filesystem permissions in staging.
2. Verify the Hub starts with zero external MCP processes.
3. Register one reviewed server in disabled/pending state.
4. Approve its tools separately, then explicitly start it.
5. Verify audit records contain identities and outcomes but no credentials.
6. Disable and remove the server; verify the child process and descendants exit.
7. Trigger a hung tool call; verify timeout, degraded health, process termination,
   and denial of subsequent calls.
8. Restart the Hub and verify no pending server auto-starts.
9. Capture test output, service configuration, and security-review findings as
   release evidence.

Until the release prerequisites and rollout checklist are evidenced, keep the
MCP runtime feature disabled and PR #153 in Draft.
