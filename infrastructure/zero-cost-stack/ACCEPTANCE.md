# Zero-Cost Stack: Deployment Acceptance

This checklist is the boundary between static repository validation and a real host deployment. A green GitHub workflow does **not** mean the services have started or that an AI task has completed.

## 1. Host prerequisites

Use a dedicated Linux host with Docker Engine and the Compose v2 plugin. Before starting, check available RAM, disk space and CPU. The default qwen2.5-coder:7b model can be too large for small VPS instances; choose a smaller model by setting OLLAMA_ACCEPTANCE_MODEL when running the acceptance script, and update the n8n workflow model to the same installed model before importing it.

From this directory:

```bash
bash ./scripts/bootstrap-env.sh
# Review .env; do not commit or share it.
docker compose config --quiet
docker compose up -d
docker compose ps
```

Pull the selected model:

```bash
docker compose exec ollama ollama pull qwen2.5-coder:7b
```

## 2. Service acceptance

Run the read-only checks:

```bash
bash ./scripts/runtime-acceptance.sh
```

A pass requires all six containers, PostgreSQL connectivity, both application databases, Redis PING, the selected Ollama model, a real structured Ollama inference, n8n health, Activepieces HTTP response and LanguageTool languages API.

If a check fails, inspect only the affected service first:

```bash
docker compose ps
docker compose logs --tail=150 postgres redis ollama n8n activepieces languagetool
```

Do not delete volumes to make a test pass. PostgreSQL init scripts run only when the data directory is empty; for an existing volume, create the missing roles/databases through an explicitly reviewed migration instead.

## 3. Secure the n8n webhook before activation

The checked-in workflow at workflows/webhook-to-llm-pipeline.json is deliberately **inactive and unauthenticated** as an import template. Never activate it in that state and never publish it to the internet.

In the n8n UI, before activation:

1. Create a new **Header Auth** credential. Use a dedicated header such as X-Agentforge-Token and a randomly generated secret. Store the secret in your password manager or deployment secret store, not in Git.
2. Open the **Incoming AI Task** Webhook node and set Authentication to **Header Auth**; select the credential created in the previous step.
3. Save the workflow and verify that the workflow export references the credential by n8n credential ID/name but does not contain the secret value. Keep the export out of Git if it contains environment-specific identifiers.
4. Keep the n8n UI and webhook bound to loopback or behind a trusted TLS reverse proxy. Add request rate limiting and a request-body limit at the proxy/firewall. The workflow also rejects empty tasks and tasks over 12,000 characters.
5. Test the production webhook URL with no header (must be rejected), with a wrong header (must be rejected), and with the correct header (must return a validated JSON response). Do not paste the token into logs or chat.
6. Only then activate the workflow.

The repository template CI intentionally asserts that the imported workflow remains inactive and has no credential attached. Once credentials are configured on a host, prove the configured workflow separately with the negative and positive tests above.

## 4. Activepieces isolation warning

The current Compose scaffold sets AP_EXECUTION_MODE=UNSANDBOXED. This is acceptable only for a trusted, single-admin local test host. It is **not** safe for public multi-user access or untrusted flows. Keep the service loopback-only. Do not expose it through Caddy or another public proxy until a supported sandboxed execution mode has been configured and tested for the pinned Activepieces version.

## 5. Evidence to attach before review / production

Record the following in the deployment ticket (never include credentials):

- Host OS, Docker Engine and Compose versions.
- Image tags/digests and selected Ollama model.
- Output of docker compose ps and the runtime acceptance summary.
- n8n no-token / wrong-token rejection results and authenticated success result.
- A sample redacted task ID, execution ID and validated response schema.
- Activepieces isolation decision and reverse-proxy exposure decision.

A deployment is accepted only when these host-level checks pass. GitHub CI currently validates source syntax, JSON, Compose rendering and the safe inactive workflow template; it does not execute this deployment checklist.
