# Sandbox deadline review

P1: attached Docker CLI may wait forever if its process ignores SIGTERM. Fixed using an independent command deadline, SIGKILL for the CLI, force-removal and bounded cleanup completion. Queue callback is delivered once. Cleanup failure cannot report success.

Local syntax and three process regressions passed. Docker unavailable locally. CI now resolves a disposable test image digest and runs actual nonroot/filesystem/network/timeout-removal checks without secrets. Production runtime still never pulls images and remains opt-in. Actual Docker and full CI results pending; do not activate or release until proven. Resume PR #39 current checks and production image provisioning using existing resources.
