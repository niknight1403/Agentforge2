# Agentforge2 Core — Selbstheilende Multi-Agenten-Basis

Produktionsreifes TypeScript-Fundament fuer das Agentforge2-Multi-Agenten-System.
Vollstaendig fehlertolerant: ohne Redis und Collector laeuft alles im No-Op-Modus.

## Module

| Modul | Datei | Aufgabe |
|---|---|---|
| Event-Bus | `src/infrastructure/RedisEventBus.ts` | Asynchrone Agent-Events ueber Redis Streams mit Consumer-Groups, Poison-Pill-Schutz, begrenzter Stream-Laenge, Lifecycle-Stop, Health-Check |
| Supervisor | `src/supervisor/HierarchicalSupervisor.ts` | Selbstheilung: erkennt INFINITE_LOOP (identische Tool-Aufrufe) und REPEATED_FAILURE (Tool-Fehler-Serien), reagiert mit Prompt-Mutation, Fallback-Modell, Checkpoint/Restore-Zeitreise |
| Circuit-Breaker | `src/llm/LLMCircuitBreaker.ts` | Pro Provider: CLOSED -> OPEN bei Schwellwert oder 429, HALF_OPEN-Einzelprobe nach Recovery; Transport injizierbar |
| Telemetry | `src/telemetry/AgentTelemetry.ts` | OpenTelemetry-Tracing pro Agent-Schritt; ohne Collector No-Op |
| Persistenz | `prisma/schema.prisma` | PostgreSQL: AgentTask / AgentStep / AgentCheckpoint mit TaskStatus-Enum |
| Infrastruktur | `docker-compose.core.yml` | PostgreSQL 16, Redis 7, OTel-Collector (Healthchecks inklusive) |

## Nutzung

```bash
npm install && npm run build && npm test   # alles gruen ohne externe Dienste
docker compose -f core/docker-compose.core.yml up -d   # Infrastruktur
DATABASE_URL=postgresql://agentforge:...@localhost:5432/agentforge2_db npm run prisma:generate
```

## Integration in den Live-Hub (Migrationspfad)

1. `bootstrapCore({ redisUrl, otelEndpoint })` — fehlerfrei auch ohne Dienste.
2. Supervisor: pro Agent-Turn `analyzeExecution(steps)` aufrufen; bei
   `MUTATE_PROMPT`/`FALLBACK_MODEL` die Rueckgabe in den naechsten Prompt/
   Modellwechsel einspeisen. Checkpoints via Prisma `AgentCheckpoint`.
3. Circuit-Breaker um die LLM-Kaskade der Routen legen (je Route eine Instanz).
4. Event-Bus: `villa:events`-Stream fuer Task-Lifecycle (created/started/completed)
   mit Consumer-Group `orchestrator`; Redis via docker-compose.core.yml.
