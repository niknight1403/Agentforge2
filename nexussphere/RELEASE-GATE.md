# NexusSphere Release Gate

A release is allowed only when CI proves: Rust tests, Node unit/integration/E2E tests, build and smoke. Production additionally requires live Villa 38 workspace deployment evidence, authenticated Hub Free Route Hunter connectivity, secret storage, encrypted transport, Stripe test-mode webhook verification, rollback and release artifact. This repository foundation does not claim those live-production checks yet.
