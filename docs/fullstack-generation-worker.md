# Full-Stack Generation Worker

The opt-in worker consumes generation requests from Redis Streams and writes isolated project workspaces.

## Start

```bash
REDIS_URL=redis://127.0.0.1:6379 VF_PROJECT_SANDBOX=docker VF_NPM_CACHE_DIR=/srv/agentforge/npm-cache npm run worker:generation
```

Default stream: `agentforge:events:stream`; consumer group: `fullstack-generation-v1`.

## Retry and lease configuration

- `AGENTFORGE_GENERATION_LEASE_MS`: lease duration in milliseconds (default 180000; minimum 90000).
- `AGENTFORGE_GENERATION_MAX_ATTEMPTS`: maximum durable job attempts (default 5; minimum 1).
- `AGENTFORGE_GENERATION_CONSUMER`: optional explicit Redis consumer name; otherwise hostname and process ID are used.
- A unique per-claim lease-owner token fences heartbeat and state updates from stale workers. Every claim also receives a distinct workspace directory, so a reclaimed job never shares files with an older worker that may still be running. Heartbeats run every 10–30 seconds and only extend the matching owner lease.
- Retryable provider, rate-limit, network and Redis-publish failures remain pending for Redis stale-message recovery. Permanent validation/quality failures become terminal; retries are bounded.
Publish an event with Redis `XADD` fields `type=PROJECT_GENERATION_REQUESTED` and
`json={"type":"PROJECT_GENERATION_REQUESTED","id":"request-uuid","payload":{"taskId":"request-uuid","projectId":"optional-project-id","prompt":"Build ..."}}`.

## Runtime / Prisma integration

The authenticated internal Hub bridge is available to the existing Prisma-backed
AgentForge runtime when both services share VF_AGENT_RUNTIME_TOKEN and
MESH_INTERNAL_TOKEN:

- Runtime tasks use input { kind: project.generate, prompt: ..., projectId: ... }.
- The Prisma AgentWorker routes that task to POST /internal/mesh/generate and polls
  GET /internal/mesh/generate/:taskId until the generator reaches a terminal state.
- Job/checkpoint orchestration remains in the Prisma runtime; generated workspace
  metadata and worker lifecycle are tracked by the Hub generation service.
- Start the generation worker separately with Redis and VF_PROJECT_SANDBOX=docker.
  The worker refuses to execute generated build/test scripts unless Docker sandbox mode
  is explicitly enabled.

Example task input:

    {
      "kind": "project.generate",
      "projectId": "crm-001",
      "prompt": "Build a responsive CRM with contacts, deals, roles and audit history."
    }

## Lifecycle events

`PROJECT_PLANNED`, `SCAFFOLD_GENERATED`, `CONTAINER_TEST_PASSED` /
`CONTAINER_TEST_FAILED`, `CHECKPOINT_SAVED`, and `STREAM_COMPLETE` are appended
to the same stream. Lifecycle telemetry contains metadata only, never prompts, source code, credentials,
or model responses. The initial request event necessarily carries the user prompt for the worker. SQLite stores job/checkpoint state locally.

## Safety and limits

- Output is limited to 80 UTF-8 text files and 1.5 MB per generation.
- Absolute paths, traversal, duplicate paths and Git metadata paths are rejected.
- The existing LLM cascade is used with CODER/REVIEWER roles; no provider is hard-coded.
- The existing project command allowlist and sandbox policy are reused. Production
  fails closed if the pinned Docker sandbox is not configured.
- Dependencies are installed with `npm install --offline --ignore-scripts` inside one
  pinned, network-isolated Docker stage, followed by build and tests in that same stage.
  The host must provide a prewarmed cache directory via VF_NPM_CACHE_DIR, mounted into the
  container at /npm-cache. No package downloads or lifecycle scripts are allowed. A cache
  miss fails the quality gate closed.
- A failed event remains pending for bounded stale-consumer recovery. Duplicate completed
  request IDs are idempotently acknowledged.

## Verification

`npm test -- --test-name-pattern=generation-engine` and `npm run check:syntax`.
The worker is opt-in and is not started inside the HTTP Hub process; deploy it as a
separate supervised process after configuring Redis and the production Docker sandbox.
The Prisma runtime bridge is opt-in per task via kind=project.generate; normal Hub
agent tasks continue through the existing Hub executor.
