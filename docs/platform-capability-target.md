# VillaForge capability target and isolated execution foundation

## Target, not a parity claim

- Base44: generate real frontend/backend/data/authentication, preview, deployment and authorized connectors. References: https://base44.com/ and https://github.com/base44/skills/tree/main/skills/base44-sandbox
- Manus: browser tools, project knowledge and multi-step automation. Reference: https://www.manus.im/features
- Replit: edit-run-browser-test-repair with real user flows. Reference: https://replit.com/blog/automated-self-testing
- CodeRabbit: independent diff/context review with actionable defects. Reference: https://www.coderabbit.ai/faq

Existing VillaForge orchestration, capability-gap requests, tools, checkpoints, CI and provider cascade remain the integration points. No duplicate scheduler, provider catalog or database is added. Existing app-generation claims are not acceptance evidence. Villa 18 source inspection demonstrated placeholder entry/build/smoke code; it remains unaccepted.

## First implementation: opt-in execution isolation

Set VF_PROJECT_SANDBOX=docker and VF_PROJECT_SANDBOX_IMAGE to a locally available image pinned by sha256 digest. Image must provide the project's runtime/dependencies and permit UID 1000 workspace access. No image is downloaded. Docker failures never fall back to host mode. Existing host mode remains unchanged until isolated production execution is actually verified.

Container: nonroot UID/GID, no network, read-only root filesystem, dropped capabilities, no privilege escalation, bounded CPU/RAM/PIDs/tmpfs, project-only writable bind mount. No host environment or Docker socket is mounted. Unique named container is force-removed after completion/error, including timeout callbacks; cleanup is bounded. Existing outer command policy/time limit/queue remain in force. This is Docker isolation, not a proof against kernel vulnerabilities.

Checks executed: syntax check of fs-tools.mjs; three focused regression tests passed. These inspect invocation and cleanup contracts, not an actual Docker execution. Full integration and timeout/cleanup tests in Docker remain required before enabling. Python/Android projects require suitable existing pinned images; do not claim support based on a Node image.

## Next acceptance gates

1. Real Docker build/test/smoke run, attempted filesystem/network escape blocked, timed-out container absent afterward.
2. Genuine runnable full-stack project, persistent user data and authorization tests.
3. Project browser runner with screenshots and real navigation/error-state checks.
4. Independent source-diff review and bounded repair, with regression tests for findings.
5. Verified preview/export/APK and deployed health from the same source commit.
6. OAuth/MCP connectors only after explicit provider authorization and execution proof.

No paid resource or new account is provisioned. Missing media providers remain missing. No complete parity or all-green release claimed.
