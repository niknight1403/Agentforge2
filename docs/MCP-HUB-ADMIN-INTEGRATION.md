# MCP Hub administrator integration

The Hub mounts the MCP registry administration API at `/api/admin/mcp/*`.
Every request passes through the Hub's existing session/API-token authentication
and administrator-role check before the framework-neutral handler is called.
The handler never accepts caller-supplied launch policy or SDK constructors.

## Supported endpoints

- `GET /api/admin/mcp/servers` — list registered servers and sanitized runtime state.
- `POST /api/admin/mcp/servers` — register a server in pending state.
- `GET /api/admin/mcp/servers/:id/tools` — list discovered tools.
- `POST /api/admin/mcp/servers/:id/start` — explicitly start an allowlisted stdio server.
- `POST /api/admin/mcp/servers/:id/stop` — stop a runtime.
- `POST /api/admin/mcp/servers/:id/disable` — stop and disable a server.
- `POST /api/admin/mcp/tools/:id/policy` — approve, block, or return a tool to pending.
- `DELETE /api/admin/mcp/servers/:id` — stop before removing a registry entry.

Pending servers are never started automatically. Only stdio can be started by
this runtime; remote transports remain registry-only.

## Deployment-owned launch policy

Starting a stdio server returns HTTP 503 unless BOTH the deployment-owned
`MCP_STDIO_LAUNCH_POLICY_JSON` and the explicit shared-namespace acknowledgement
`MCP_STDIO_ALLOW_SHARED_HUB_NAMESPACE=true` are configured. The acknowledgement
is an unsafe compatibility switch for trusted, operator-reviewed servers only;
it does not create per-server isolation and must never be used for untrusted MCP
servers. Without it, startup is blocked before executable policy evaluation.
It is a JSON object with an `executables` array. Example:

```json
{
  "executables": [{
    "path": "/usr/bin/node",
    "workingDirectories": ["/srv/mcp"],
    "allowedEnvironmentKeys": ["NODE_ENV"],
    "allowedArgs": [["/srv/mcp/server.mjs"]],
    "credentialEnvKey": "MCP_SERVER_TOKEN"
  }]
}
```

The policy is exact-match and fail-closed: the executable path must match one
entry, working directories and environment keys must be explicitly listed,
and arguments must exactly match one allowed argument vector. Paths are
resolved with `realpath` before use. Do not place secrets in this JSON; bearer
credentials remain in the encrypted MCP credential vault and are injected
only through the configured credential environment key.

Set the JSON as a protected deployment secret/environment variable. Never
accept it through the registry API.

## Optional Docker hardening baseline

For the Agent Mesh Compose deployment, an additional baseline is provided in
`docker-compose.mcp-hardening.yml`. Apply it alongside the existing file:

```sh
docker compose -f docker-compose.agent-mesh.yml \
  -f docker-compose.mcp-hardening.yml config
docker compose -f docker-compose.agent-mesh.yml \
  -f docker-compose.mcp-hardening.yml up -d --build
```

The overlay runs the Hub as UID/GID 1000 (the `node` user in
`Dockerfile.agentforge`), makes the container root filesystem read-only,
drops Linux capabilities, enables `no-new-privileges`, and sets PID, CPU,
memory, and temporary-filesystem limits. The persistent `/data` volume
remains writable for the application database. Review and tune resource limits
for the actual workload before applying the overlay.

**This is a container-wide baseline, not per-MCP-server isolation.** MCP child
processes still share the Hub's UID, filesystem mounts, network namespace,
resource budget, and access to the Hub's writable data volume. The overlay
does not implement network egress allowlisting, separate per-server cgroups,
or a separate container for each MCP server. Do not enable untrusted MCP
servers on this basis.

## Process lifecycle and operational boundary

The Hub uses its own POSIX stdio transport with a detached process group. It
closes stdin, sends SIGTERM to the complete process group, waits for the group
to disappear, then sends SIGKILL if needed. A process group that remains after
the forced-kill deadline is reported as an unconfirmed teardown and the admin
API returns HTTP 503. Windows startup is deliberately disabled until equivalent
Job Object process-tree teardown is implemented and tested.

Process-group teardown plus the optional container baseline is still not a
complete per-server sandbox. Before enabling untrusted MCP servers, deploy
each server under a separate low-privilege identity/container with explicit
filesystem mounts, network egress policy, CPU/memory/PID limits, and cgroup or
systemd containment, then verify those controls in the target environment.
Independent security review and deployment evidence remain required.
