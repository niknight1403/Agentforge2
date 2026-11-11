# DeepAgent Live Development Workspace

## User experience

Starting an idea opens its persistent DeepAgent project chat immediately. The project conversation remains the primary workspace while autonomous development is handed to the existing VillaForge pipeline. Starting that handoff no longer navigates away to a separate Villa screen.

The Android workspace polls the existing project completion report every five seconds and displays:
- product and handover gate state, blockers and next action;
- linked Villa ID and live-preview availability;
- host runtime capability inventory for administrator sessions;
- the latest SSE events associated with the linked Villa;
- an embedded WebView preview when a real project build entry point exists.

The preview is served from the Deep project directory only. The file resolver canonicalizes paths, rejects traversal and .env paths, resolves symlinks before checking the allowlisted build roots (dist, build, out, public, web-dist) and only returns regular files. The WebView attaches the Hub bearer token only to requests on the Hub origin.

## Administrator capability model

The runtime capability inventory endpoint requires administrator access (or the explicitly configured open mode). The workspace reports detected host binaries as availability probes, not as proof that a tool is configured or that an output has passed acceptance.

Administrator visibility does not bypass:
- product acceptance and handover gates;
- missing binary/provider credentials;
- provider rate limits, budgets or unavailable routes;
- user data isolation and server authorization;
- explicit confirmations for destructive or external actions.

The administrator can use all capabilities that are actually installed, configured and authorized. Missing capabilities remain visible as gaps rather than being simulated.

## Validation required before release

- Node tests for preview path confinement.
- Server tests and existing DeepAgent/product-gate regression suite.
- Android Kotlin compile and APK build.
- Authenticated preview smoke test with HTML plus relative/absolute JS and CSS assets.
- Live SSE verification for a real linked Villa.
- Non-admin denial for runtime capability inventory.
- Admin access verification with the real deployment session.

A preview is shown only when a real entry file exists. A status card or successful HTTP response is not itself a product acceptance claim.