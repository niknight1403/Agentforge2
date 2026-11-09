# Full-Stack Generation Worker

The opt-in worker consumes generation requests from Redis Streams and writes isolated project workspaces.

## Start

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run worker:generation
```

Default stream: `agentforge:events:stream`; consumer group: `fullstack-generation-v1`.
Publish an event with Redis `XADD` fields `type=PROJECT_GENERATION_REQUESTED` and
`json={"type":"PROJECT_GENERATION_REQUESTED","id":"request-uuid","payload":{"taskId":"request-uuid","projectId":"optional-project-id","prompt":"Build ..."}}`.

## Lifecycle events

`PROJECT_PLANNED`, `SCAFFOLD_GENERATED`, `CONTAINER_TEST_PASSED` /
`CONTAINER_TEST_FAILED`, `CHECKPOINT_SAVED`, and `STREAM_COMPLETE` are appended
to the same stream. Payloads contain metadata only, never prompts, source code, credentials,
or model responses. SQLite stores job/checkpoint state locally.

## Safety and limits

- Output is limited to 80 UTF-8 text files and 1.5 MB per generation.
- Absolute paths, traversal, duplicate paths and Git metadata paths are rejected.
- The existing LLM cascade is used with CODER/REVIEWER roles; no provider is hard-coded.
- The existing project command allowlist and sandbox policy are reused. Production
  fails closed if the pinned Docker sandbox is not configured.
- The worker never runs `npm install` or downloads packages. Dependencies must already
  be present in the generated workspace image; otherwise the quality gate reports the
  build/test as not configured or failed.
- A failed event remains pending for bounded stale-consumer recovery. Duplicate completed
  request IDs are idempotently acknowledged.

## Verification

`npm test -- --test-name-pattern=generation-engine` and `npm run check:syntax`.
The worker is opt-in and is not started inside the HTTP Hub process; deploy it as a
separate supervised process after configuring Redis and the production sandbox.
