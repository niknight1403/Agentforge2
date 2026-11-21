# Platform stack refresh — 2026-11-21

Status: baseline audit and implementation plan. This document is not a claim that every integration is production-enabled.

## Verified baseline on main

### Free Route Hunter and LLM routing
- `server/free-route-hunter.mjs` discovers local Ollama models and a deliberately small keyless candidate set, deduplicates candidates, and maintains route health/cooldown data.
- The Hunter monitor is free-only, validates real OpenAI-compatible completion payloads before marking a route healthy, and excludes routes whose persisted cooldown has not expired (PRs #197 and #202).
- Remote Ollama/LM Studio endpoints are not local by provider name alone; remote self-hosted hosts require HTTPS and an exact `VF_SELF_HOSTED_ALLOWED_HOSTS` allowlist (PR #206).
- Provider RPM limits are selected by provider identity rather than display name, including xAI, and `VF_RPM_*` settings load from env files (PR #211).
- Missing provider-catalog entries are synchronized without overwriting existing route decisions; paid/credit-based routes remain disabled by default. The Hunter starts after a short delay, runs health checks every 30 minutes and full discovery every 6 hours without overlapping cycles (PR #215, pending CI).
- `server/free-route-client.mjs` reads the existing authenticated `/api/free-routes` endpoint, rejects redirects, bounds freshness/timeouts and returns no available providers from stale snapshots (PR #41).
- `server/llm-route-policy.mjs` validates provider host, path, protocol and credential environment aliases. `server/llm-cascade.mjs` applies free-only filtering, route ordering, concurrency queues, cooldown-aware retries and circuit/failure handling.
- Keyless Pollinations and local Ollama are not equivalent to guaranteed uptime. A route is usable only after live health evidence; no model response should be fabricated when all routes fail.

### API and authentication
- `server/api-gateway.mjs` provides scoped gateway tokens/API-key principals and validates issuer, audience, role, scope and expiry.
- Follow-up: inventory every public route for consistent authentication, per-user Villa ownership, request-size limits, idempotency and rate limiting; add contract tests for the full public API surface.

### MCP
- The Hub has an encrypted AES-256-GCM credential vault, transport policy, registry, rootless Podman runner/adapter, supervisor and runtime integration tests.
- Active MCP tools with explicit approval are exposed to agents through dynamic aliases; enabled HTTPS JSON connectors are exposed as GET-only tools. MCP/connector arguments and results are redacted from traces/audit (PR #209).
- MCP discovery binds the client to the registered server ID, and identity denials remain fail-closed even if audit storage fails (PR #205).
- `docs/MCP-PER-SERVER-ISOLATION-ADR.md` explicitly says shared-Hub namespace execution is not per-server isolation. Untrusted MCP servers must remain blocked until a deployment-owned runner profile verifies OS/container isolation, egress policy, resource limits, credential injection and teardown.
- Do not weaken the fail-closed isolation gate or silently fall back to shared namespace execution.

### TTS / speech / audio
- Local browser/device speech playback with start/stop controls is integrated in the web master chat and Android Villa/DeepAgent chats (PR #201). Browser SpeechSynthesis and Android TextToSpeech use the device/browser engine; no cloud key is required.
- This is local playback, not a hosted TTS API, voice cloning, or generated audio-file service. A provider-neutral hosted TTS adapter, voice catalogue, audio artifact pipeline, usage/cost reporting, and live provider acceptance remain unimplemented.

### UI / UX / AI
- Web master UI currently sends idempotent request IDs, polls pending turns, and displays an explicit LLM-unavailable result rather than inventing a response.
- Android Compose shell has dashboard, DeepAgent/chat, diagnostics, capabilities, settings and file-manager screens with a shared Aurora background.
- The web master UI displays the admin integration inventory: live LLM route status, Free-Only mode, and approved MCP tools. The inventory endpoint is admin-only and hides secrets/full connector URLs (PR #209).
- Next UX pass: unify web/mobile capability and connection states, expose stale/healthy/degraded/offline states, show real task and build evidence, improve keyboard/screen-reader semantics, and avoid decorative success indicators without backend evidence.
- AI/agent quality: preserve the real-model-only failure path, per-Villa sequential task execution, bounded global Villa concurrency, and evidence-backed completion gates.

### Xi / xAI
- `xai` is present in the LLM provider allowlist with `api.x.ai` and `XAI_API_KEY`.
- This proves route-policy recognition only; it does not prove a valid account key, model entitlement, live reachability, or successful generation.

## Upgrade order and acceptance gates

1. **Route reliability:** unit tests for free-only selection, persisted cooldown, 401/403 disablement, 429 backoff, duplicate endpoint suppression, provider timeouts and stale route snapshots. Live probes must be opt-in and bounded.
2. **LLM provider adapters:** run mocked contract tests for every allowlisted provider; verify auth header, endpoint path, response parsing, token/time budgets, retry classification and secret redaction. Do not mark a provider healthy based on configuration alone.
3. **API security:** enumerate routes and enforce authentication/authorization, owner scoping, validation, limits, idempotency and audit coverage. Add negative tests for cross-user and cross-Villa access.
4. **MCP isolation:** complete per-server runner isolation and adversarial integration tests before enabling untrusted servers. Keep credentials scoped to one server and one runtime lifetime.
5. **TTS:** implement adapter and API contract, then mocked tests; live provider smoke tests remain opt-in.
6. **AI orchestration:** test cancellation, checkpoint/recovery, task ordering, retry/DLQ behavior, bounded queues and no false-completion states.
7. **UI/UX:** browser and Android tests for connection states, pending turns, task timeline, preview, accessibility, responsive layouts and error recovery.
8. **Release / XI:** run web build, Android build, artifact checksum/download verification, provider smoke tests and a signed release manifest. xAI is one provider among the allowlisted routes and requires separate live acceptance.

## Release rule

A merged code change, configured provider, passing unit test, or successful CI workflow is not by itself production acceptance. Report each layer separately: code merged, tests passed, live provider verified, deployment healthy, and artifact downloadable. Never expose secrets in logs or reports.
