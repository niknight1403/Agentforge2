# Agent Academy integration plan

## Ownership boundary

Agentforge2 remains authoritative for Villa records, task scheduling, user permissions, execution, billing and deployment. Agent Academy is a separately deployable Python service for repository ingestion, evidence indexing, architecture analysis and advisory optimization.

## Initial implementation

The isolated service lives in `agent-academy/` and exposes:
- service health metadata at `GET /health` (not an authenticated readiness check);
- authenticated repository ingestion at `POST /api/academy/sync-repos`;
- authenticated architecture analysis and deterministic audit at `POST /api/academy/analyze-synergies`;
- authenticated advisory prompt/workflow review at `POST /api/academy/optimize-agents`;
- authenticated persistent knowledge search at `GET /api/academy/knowledge/search`.

SQLite FTS5 is the initial persistent retrieval adapter. The storage interface is deliberately independent of ChromaDB so a vector backend can be selected after measuring deployment memory, disk and concurrency constraints.

## Security boundaries

- The API fails closed when `ACADEMY_API_TOKEN` is absent.
- Repository URLs must be canonical GitHub HTTPS URLs; owners are allowlisted.
- Repository names are validated and checkout paths are confined to the managed data directory.
- Repository content is untrusted data, never executable instructions.
- LLM execution is disabled by default. The first implementation uses the configured local Ollama endpoint through LiteLLM when explicitly enabled.
- The optimizer returns proposals only. It cannot write prompts, modify repositories, merge PRs or deploy.
- No GitHub token is needed for public repositories. Private repository support requires a separate credential broker and must not embed tokens in clone URLs.

## Follow-on integration gates

1. Deploy the service privately with persistent storage and a service-to-service secret.
2. Add a Node.js adapter in the existing Agentforge2 server, using the current authentication and authorization middleware.
3. Map Villa/project IDs through the existing hub database; do not create a second Villa registry.
4. Add queue-backed ingestion, cancellation, idempotency and progress events.
5. Add an embedding provider and vector index only after resource profiling; preserve SQLite metadata and source references.
6. Add end-to-end tests proving authenticated Node-to-Python calls, tenant isolation, restart persistence and failure handling.
7. Expose the Academy dashboard only after backend integration and permission checks pass.

## Acceptance criteria

- Python CI is green.
- Missing service credentials are rejected.
- Unapproved or malformed GitHub targets are rejected.
- Indexing persists across process restarts.
- Failed ingestion is reported per repository and never represented as success.
- LLM use is opt-in and advisory output cannot mutate production state.
- Node/Villa integration and production deployment remain explicitly unaccepted until their own tests pass.
