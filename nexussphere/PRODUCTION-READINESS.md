# NexusSphere Production Readiness

This file records verified gates, not marketing claims.

## Automated release gate
- Rust tests must pass with locked dependencies.
- Node unit, integration, security, billing, principal, runtime and E2E tests must pass.
- Web artifact must build to `dist/index.html` and pass smoke verification.
- Production Docker image must build and answer `GET /health` from a running container.
- NexusSphere completion must call only the authenticated Agentforge2 Hub endpoint; provider credentials and provider-specific calls remain in the Hub cascade.
- Kubernetes manifest must use Secret references, non-root execution, dropped capabilities, read-only root filesystem, probes, resource bounds and persistent state.

## Live gates still required before claiming production deployment
- Deploy the exact green commit to Villa 38 and capture deployment evidence.
- Verify authenticated Hub completion against the live Free-Only cascade without exposing credentials.
- Provision real Kubernetes secrets outside Git and verify secret rotation.
- Configure Stripe test-mode webhook endpoint and verify signed test events end-to-end.
- Verify backup/restore for state volume and rollback to the previous image.
- Record release artifact digest and deployed image digest.

MRR is a business target and is never treated as technical acceptance evidence.
