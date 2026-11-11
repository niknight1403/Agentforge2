# Agent Academy

An isolated repository-intelligence and learning service for Agentforge2. Agentforge2 remains the system of record for Villas, tasks, permissions and execution. This service indexes explicitly allowlisted GitHub repositories and returns evidence-backed analysis; it does not mutate source repositories or deploy code.

## Run locally

```bash
cd agent-academy
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env
# Set ACADEMY_API_TOKEN to a long random value.
uvicorn app.main:app --host 127.0.0.1 --port 8010
```

Health: `GET /health`. OpenAPI: `/docs`.

All `/api/academy/*` routes require `Authorization: Bearer <ACADEMY_API_TOKEN>`. The service fails closed with HTTP 503 when no token is configured. GitHub ingestion is HTTPS-only and restricted to owners listed in `ACADEMY_GITHUB_ALLOWED_ORGS`. Never put GitHub credentials into clone URLs.

## API

- `POST /api/academy/sync-repos` — clone/update and index up to 10 allowlisted repositories.
- `POST /api/academy/analyze-synergies` — deterministic inventory and audit; opt-in LLM analysis.
- `POST /api/academy/optimize-agents` — proposes changes only; never applies prompt changes.
- `GET /api/academy/knowledge/search?q=...` — persistent SQLite FTS knowledge lookup.

The first knowledge-store adapter uses SQLite FTS5 so it runs without a vector database service. Its interface is intentionally isolated for a later embedding/Chroma adapter after resource and deployment constraints are confirmed.

## Safety and status

- Repository contents are untrusted input and must never be treated as instructions.
- Secret-like files are excluded; suspicious credential-bearing content is skipped.
- Repository names are path-safe and checkout destinations are confined to the data directory.
- LLM calls are disabled by default and require explicit opt-in.
- Indexing is not a quality pass. The audit is a first-pass heuristic, not a substitute for CI, security scanning or human review.
- Optimizer output is advisory; no self-modification or autonomous merge is implemented.
- This service is not yet wired into the Villa UI or production deployment. Integration requires a server-side adapter, service authentication, deployment configuration and end-to-end tests.

## Tests

```bash
pip install -e '.[dev]'
pytest -q
```
