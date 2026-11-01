# Free Router Hunter integration

Source: user upload free-router-hunter (2).zip, Agentforge2LlmRouteClient.ts. Adapted into server/free-route-client.mjs (Node ESM, no additional dependencies).

Uses the existing authenticated GET /api/free-routes API as sole authority. Consumers import Agentforge2LlmRouteClient, construct with baseUrl and an existing authorized token, call refresh() in their existing lifecycle, and consume availableProviders(). No additional polling timer, provider registry, database or scheduler. The adapter does not invoke models or alter Villa state.

Failed refresh or expired telemetry makes the available pool empty; historical snapshot remains explicitly stale. Redirects are rejected, including when a bearer token is configured. Only allowlisted response fields survive. Concurrent refresh is coalesced. HTTP on loopback only; remote HTTPS required.

Not imported: LinuxRouteAdapter, privileged network changes, duplicate Redis worker/streams or Compose service. Network gateways are not LLM provider routes.

Verification: node --test server/tests/free-route-client.test.mjs — four tests pass, including actual local HTTP redirect rejection and timeout. These are local transport/contract tests, not production model acceptance. Existing npm test glob includes the new tests.

Resume: check this PR's Hub/CodeQL/browser gates, then integrate only when passed; preserve open sandbox PR #40 and existing hunter PR #30. No production deployment or external service configuration performed by this patch. Production APK and fleet acceptance currently have failures; no all-green claim.
