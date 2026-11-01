# Correct available-memory measurement

Baseline: 54f72e615459cdc4b78b9379f3bdf8bccd7fe97b

Observed host snapshot: 23972 MiB total, 332 MiB free, 3369 MiB available. Using free RAM counts reclaimable Linux cache as pressure (~98.6% used) and can force the existing CRITICAL recommendation of one task. MemAvailable gives ~85.9% pressure for the same snapshot, retaining the existing WARNING limits. CPU/GPU and other memory thresholds are unchanged. No additional slots, provider quotas, Villa starts or paid resources are configured.

The resource agent now reads MemAvailable from /proc/meminfo, bounded to total RAM, with the previous portable fallback when unavailable. This does not implement separate cgroup-aware accounting; container budgets must still be evaluated independently.

Executed: node --test server/tests/resource-memory.test.mjs — 2 passed, exit 0. Fixtures cover recorded host conditions, missing/malformed proc data, fallback and clamping. Full integration CI and production measurements pending. No throughput multiplier claimed.

Fresh independent real Master proof before this patch: https://github.com/niknight1403/Agentforge2/actions/runs/41275172557 — HTTP 200, actual start instructions, no side effects, CAX11 3B, 16.6s, version 1.60.5. This does not prove Villa product completion.

Resume: PR checks/review, integrate without overlapping deploy, then measure resource recommendation and accepted outputs under equal load. Product acceptance remains the priority; no release without genuine artifacts and gates.
