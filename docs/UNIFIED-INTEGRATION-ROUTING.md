# Unified LLM, API and Agent Tool Routing

## Runtime contract

The Node Hub uses one persisted route table and a common OpenAI Chat Completions adapter for compatible text providers. The startup synchronizer registers the built-in route catalog idempotently. It never overwrites an existing administrator enable/disable decision.

A route is usable only when all applicable conditions are true:
- The route is enabled in the route table.
- Its required credential is present (unless the route is keyless).
- The provider is allowed by the current free-only policy.
- The route is outside cooldown/circuit-breaker windows and passes the route admission budget.
- The configured endpoint passes the route scope and transport checks.

The default is `VF_LLM_FREE_ONLY=1`. Paid, credit-based and unverified providers are registered as disabled presets. To use one, an administrator must configure its credential, explicitly enable the route, and explicitly opt out of free-only mode. This is intentionally a two-step cost guard. A catalog entry is not proof that an account has free quota or that the endpoint is currently healthy.

## Built-in text provider catalog

| Provider | Endpoint | Credential | Default policy |
|---|---|---|---|
| Google Gemini (Flash-Lite) | `generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Free-tier model allowlist |
| Groq | `api.groq.com/openai/v1` | `GROQ_API_KEY` | Explicit model allowlist |
| OpenRouter | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | Only `:free` / `openrouter/free` |
| Pollinations | `text.pollinations.ai/openai` | none | Canonical keyless endpoint |
| Cerebras | `api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | Disabled; credits/quota may expire |
| Mistral | `api.mistral.ai/v1` | `MISTRAL_API_KEY` | Disabled by default |
| xAI | `api.x.ai/v1` | `XAI_API_KEY` | Disabled; opt-in model via `VF_XAI_MODEL` |
| Hugging Face | `router.huggingface.co/v1` | `HF_TOKEN` or `HUGGINGFACE_API_KEY` | Disabled; inference credits may be required |
| SambaNova | `api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` | Disabled pending account/quota validation |
| NVIDIA NIM | `integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | Disabled; credits/quota may apply |
| Zhipu | `open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | Disabled pending account/quota validation |
| Chutes | `llm.chutes.ai/v1` | `CHUTES_API_KEY` | Disabled pending account/quota validation |
| Hyperbolic | `api.hyperbolic.xyz/v1` | `HYPERBOLIC_API_KEY` | Disabled pending account/quota validation |
| Together | `api.together.xyz/v1` | `TOGETHER_API_KEY` | Disabled; model pricing varies |
| Fal OpenRouter proxy | `fal.run/openrouter/router/openai/v1` | `FAL_KEY` | Disabled; uses Fal's `Key` authorization scheme |
| Modal serverless endpoint | operator-provided HTTPS URL | `MODAL_API_KEY` | Not registered until `MODAL_BASE_URL` is configured |
| Ollama / LM Studio | operator-provided local or trusted HTTPS endpoint | optional | Self-hosted route; endpoint must be reachable from the Hub |

The provider catalog uses the current model presets in `server/routes.mjs`. Model IDs and provider quotas change independently of this repository; verify them against the provider's current account and API documentation before enabling a route.

## Environment and credential handling

The Hub reads only an explicit allowlist of provider configuration names from the root `.env` and `server/.env` files. Existing process environment values win. Secret values are not logged or returned by the integration inventory.

Supported credential aliases:
- `GEMINI_API_KEY` ↔ `GOOGLE_API_KEY`
- `HF_TOKEN` ↔ `HUGGINGFACE_API_KEY`

Optional per-provider request limits use `VF_RPM_<PROVIDER>`, for example `VF_RPM_GROQ` or `VF_RPM_POLLINATIONS`. The fallback RPM is bounded and provider-specific. Do not put credentials in endpoint URLs. Remote Ollama/LM Studio endpoints are not assumed free: add their exact hostnames to `VF_LLM_TRUSTED_SELF_HOSTED_HOSTS` only when you control the host and have verified its operating cost. Loopback endpoints are trusted automatically.

## API and tool integration

- `GET /api/routes`: persisted LLM route records; key presence only, never key values.
- `GET /api/llm/status`: current eligibility, cooldown and routing status.
- `GET /api/tools`: static agent tools plus dynamic tools from enabled connectors and approved tools on active MCP servers.
- `GET /api/connectors`: configured HTTPS JSON connector metadata.
- `GET /api/admin/mcp/servers`: administrator-only MCP server registry.
- `GET /api/admin/mcp/servers/:serverId/tools`: discovered tools for a registered MCP server.
- `POST /api/admin/mcp/tools/:toolId/policy`: administrator approval, block or pending transition.
- `GET /api/integrations`: administrator-only consolidated inventory for LLM routes, API connectors, tools, MCP and media capabilities. Endpoint paths and credentials are redacted to safe metadata.

Enabled HTTPS JSON connectors are exposed to agents as `connector:<connectorId>:read` tools. They remain GET-only and use the connector's existing DNS/public-address validation, no-redirect policy, timeout and response-size limit.

Only tools whose MCP server is active and whose registry policy is `approved` are exposed as `mcp:<serverId>:<toolName>` agent tools. Execution re-checks registry state and delegates to the supervised MCP runtime. The generic `mcp_call` tool remains available behind its tool-pack gate.

Dynamic tools are still subject to their corresponding tool-pack switch. Tool output and external descriptions are untrusted data; no connector or MCP result can grant itself new permissions.

## Media routes

Image, image-edit, video and audio generation continue through the dedicated Fal media adapter, not the text-chat endpoint. `FAL_KEY` configures that media route; actual paid media work occurs only when a media job is requested. The media capability inventory reports whether the provider is configured.

## Acceptance checklist

1. Configure only the provider credentials you are authorized to use; do not copy secrets into source files or logs.
2. Restart the Hub and inspect `GET /api/integrations`.
3. Confirm the route is present, configured, enabled and eligible before sending a test request.
4. Test one provider at a time with a minimal request; verify the reported provider/model, latency, token usage and cooldown behavior.
5. For MCP, start the server through the supervised runtime, approve the discovered tool, then verify it appears in `GET /api/tools`.
6. For connectors, enable the connector, test it through the admin connector API, then verify its dynamic read tool appears.
7. Keep paid/credit routes disabled until explicit operator approval and account-level budget limits are in place.
