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

Starting a stdio server returns HTTP 503 unless
`MCP_STDIO_LAUNCH_POLICY_JSON` is configured by the deployment environment.
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
accept it through the registry API. Configure the Hub under a dedicated
unprivileged OS identity and enforce filesystem, network egress, memory, CPU,
and process limits outside Node.js.

## Operational boundary

This integration wires the admin API to the registry and supervisor and drains
managed runtimes during graceful Hub shutdown. It does not itself provide an
OS/container sandbox or prove that every descendant process is killed after a
hung SDK request. Do not enable untrusted MCP servers until process-group or
cgroup termination is verified in the target deployment.
