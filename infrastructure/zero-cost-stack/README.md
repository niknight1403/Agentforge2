# Agentforge2 Zero-Cost AI Stack

Self-hosted foundation for local inference and workflow automation. This directory is an opt-in deployment module; it does not change the existing Hub runtime.

## Services

- Ollama: local model runtime, internal Docker network only.
- PostgreSQL: persistent application database.
- Redis: persistent queue/cache backend.
- n8n: workflow automation, PostgreSQL-backed.
- Activepieces: workflow automation, PostgreSQL + Redis-backed.
- LanguageTool: local text-quality API.
- Caddy: optional local reverse proxy (Compose profile `proxy`).

No paid provider is configured. External free-tier routing is intentionally not enabled by default; it must be explicitly configured and budget-guarded in a later adapter.

## Bootstrap

```bash
cd infrastructure/zero-cost-stack
bash ./scripts/bootstrap-env.sh
```

Review `.env`. The checked-in PostgreSQL initialization script creates separate n8n and Activepieces roles/databases on the first empty-volume initialization. If the PostgreSQL volume already exists, the init script will not run automatically.

Validate the Compose model:

```bash
docker compose config --quiet
```

Start only after secrets, database bootstrap and host resource limits have been reviewed:

```bash
docker compose up -d
```

Pull local models:

```bash
docker compose exec ollama ollama pull qwen2.5-coder:7b
docker compose exec ollama ollama pull qwen2.5:1.5b
```

Run health checks:

```bash
bash ./scripts/health-check.sh
```

## Security notes

- Ollama, PostgreSQL, Redis and LanguageTool are not published to the host.
- The reverse proxy is opt-in and binds to loopback by default.
- Never commit `.env`, tokens, database dumps or model data.
- Activepieces is configured in its unsandboxed execution mode for a single-host deployment. Treat imported flows as trusted code; do not expose this instance publicly without reviewing its isolation model.
- Pin and review image updates before production rollout.
- CPU-only is the default. Add a hardware-specific Compose override only after detecting and validating the host runtime.

## Current acceptance boundary

This is an infrastructure scaffold, not a claim of a deployed or tested service. Activepieces DB bootstrap, proxy auth, LanguageTool image/health endpoint compatibility, OpenCode runner integration, workflow import, resource limits and end-to-end checks remain explicit acceptance tasks.

## Deployment acceptance

Follow [ACCEPTANCE.md](./ACCEPTANCE.md) before activating the n8n webhook or exposing any service. It documents the host-level smoke tests, Header Auth setup, required negative/positive webhook tests, and the Activepieces unsandboxed-execution restriction. Green GitHub CI is static validation only; it is not evidence of a running deployment.
