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

The compose stack is an optional self-hosted profile. Existing production services keep their own deployment lifecycle; configuring the shared secret and applying the migration are required before cross-repository telemetry is live.
