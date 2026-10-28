# Agentforge2 + CyberSarah mesh

`docker-compose.agent-mesh.yml` runs Agentforge2, CyberSarah Control Center, Redis Streams, and PostgreSQL on loopback-only host ports. Run it from the Agentforge2 checkout with CyberSarah Control Center checked out beside it as `../CyberSarah-Control-Center`.

Create an untracked `.env` beside the compose file with two independently generated values:

```dotenv
MESH_POSTGRES_PASSWORD=<URL-safe random password>
AGENTFORGE_TELEMETRY_TOKEN=<at least 32 random bytes, hex encoded>
```

Set the same telemetry token in the Control Center's own production secret store as `AGENTFORGE_TELEMETRY_TOKEN`. Never commit either value. For the local stack, start it with:

```sh
docker compose -f docker-compose.agent-mesh.yml up --build -d
```

The compose migration job applies the Drizzle migrations before starting the Control Center. Agentforge keeps its existing SQLite transaction store for local recovery and forwards the hash-linked, sensitive-field-checked checkpoint to PostgreSQL when the telemetry URL and token are configured. Redis and PostgreSQL keep named persistent volumes. The SSE endpoint is authenticated with the existing Control Center session and only emits allowlisted operational metadata; prompts and chain-of-thought are excluded.

With the telemetry URL and token configured, Agentforge publishes allowlisted lifecycle events to the Redis stream first. A consumer group forwards them to CyberSarah and acknowledges only successful HTTP responses; pending entries are reclaimed after a consumer restart. If Redis is unavailable, a best-effort direct HTTP delivery keeps the dashboard current without blocking task execution. The consumer is intentionally a telemetry bridge: the existing Villa task scheduler remains authoritative for task execution.

The optional `otel-collector` accepts OTLP/HTTP traces on the internal Docker network at `http://otel-collector:4318/v1/traces`. Agentforge traces model-provider attempts and tool execution with identifiers and timing metadata only. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` for another collector. The bundled collector uses a bounded-memory processor and debug exporter, so traces appear in its container logs; configure a persistent exporter before relying on it for long-term retention.

The compose stack is an optional self-hosted profile. Existing production services keep their own deployment lifecycle; configuring the shared secret and applying the migration are required before cross-repository telemetry is live.
