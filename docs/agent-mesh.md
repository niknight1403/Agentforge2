# Agentforge2 + CyberSarah mesh

`docker-compose.agent-mesh.yml` runs Agentforge2, CyberSarah Control Center, Redis Streams, and PostgreSQL on loopback-only host ports. Run it from the Agentforge2 checkout with CyberSarah Control Center checked out beside it as `../CyberSarah-Control-Center`.

Create an untracked `.env` beside the compose file with two independently generated values:

```dotenv
MESH_POSTGRES_PASSWORD=<URL-safe random password>
AGENTFORGE_TELEMETRY_TOKEN=<at least 32 random bytes, hex encoded>
AGENTFORGE_MESH_TOKEN=<a different 32-byte random value, hex encoded>
```

Set the same telemetry token in the Control Center's own production secret store as `AGENTFORGE_TELEMETRY_TOKEN`. Never commit either value. For the local stack, start it with:

```sh
docker compose -f docker-compose.agent-mesh.yml up --build -d
```

The compose migration jobs apply the Drizzle and Prisma migrations before starting their services. Agentforge keeps its SQLite villa store for compatibility and uses the TypeScript runtime's Prisma/PostgreSQL database as the durable task/outbox/checkpoint store. The runtime consumes task messages from Redis Streams in a consumer group and calls the Hub's private task executor. The Hub scheduler remains authoritative for villa scheduling; an idempotent execution lock protects against late or reclaimed Redis deliveries. If the runtime cannot accept a dispatch, the Hub falls back to its local executor. Redis and PostgreSQL keep named persistent volumes. The SSE endpoint is authenticated with the existing Control Center session and only emits allowlisted operational metadata; prompts and chain-of-thought are excluded.

With the telemetry URL and token configured, Agentforge publishes allowlisted lifecycle events to the Redis stream first. A consumer group forwards them to CyberSarah and acknowledges only successful HTTP responses; pending entries are reclaimed after a consumer restart. If Redis is unavailable, a best-effort direct HTTP delivery keeps the dashboard current without blocking task execution. The consumer is intentionally a telemetry bridge: the existing Villa task scheduler remains authoritative for task execution.

The optional `otel-collector` accepts OTLP/HTTP traces on the internal Docker network at `http://otel-collector:4318/v1/traces`. Agentforge traces model-provider attempts and tool execution with identifiers and timing metadata only. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` for another collector. The bundled collector uses a bounded-memory processor and debug exporter, so traces appear in its container logs; configure a persistent exporter before relying on it for long-term retention.

The runtime also stores allowlisted task lifecycle telemetry (start, completion, retry, failure) in PostgreSQL. Prompt text, chain-of-thought, tool arguments, and user content are excluded. Records older than 30 days are pruned daily; operational spans are exported over OTLP.

The runtime pins `deepmerge-ts` 8.0.2 under Prisma's config dependency to resolve the upstream recursive-merge advisory without a Prisma major-version migration. The exact Prisma schema validation, client generation, runtime tests, and dependency audit run in CI.

`AGENTFORGE_MESH_TOKEN` is shared only between the Hub and runtime worker and must be different from the Control Center telemetry token. The compose stack is an optional self-hosted profile. Existing production services keep their own deployment lifecycle; configuring the shared tokens and applying migrations are required before cross-repository telemetry and task dispatch are live.
