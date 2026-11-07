# Redis Streams mesh integration

The typed module at `server/mesh/RedisEventBus.ts` is an additive building block, not yet active in the production hub.

## Requirements
- Install and lock `ioredis` and TypeScript in the existing Node >=22 build.
- Configure `REDIS_URL` through the secret store.
- Create per-task or per-workload consumer groups and stable consumer names.
- ACK only after a durable, idempotent task-state transaction.
- Add `XAUTOCLAIM` recovery for abandoned pending entries.
- Add a dead-letter stream and operator-visible poison-message handling.
- Use an SQL outbox to bridge PostgreSQL commits to Redis publication.
- Add integration tests with a real Redis instance, shutdown and restart tests, and telemetry.
- Never log API keys or unredacted user prompts.

Do not activate this transport for production workloads before these gates pass.
