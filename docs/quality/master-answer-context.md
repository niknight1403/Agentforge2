# Compact explicit no-action context

Baseline 530f900ca7fd0af9b951d92dba3ae02538d8a5e3

Production evidence: Master probe 41270710316, HTTP 503 after 60.3s, Gemini 429 and multiple local inference timeouts. The planning request includes a large action catalog and prior history even for explicitly non-executing explanation requests. A compact path now sends the actual current question and strict JSON/no-action instructions; any returned actions fail closed. Normal planning/execution uses the existing full context. No fake response, extra provider, quota change or Villa activation.

Executed relevant tests after syncing current control-store dependency: 17 passed, exit 0. Initial local run failed because the old snapshot lacked current listThemes exports; fixed by loading exact baseline dependency, not weakening tests.

This is not a production model proof. Resume: PR CI/review, integrate after active deployment ends, then real Master probe and detailed per-Villa audit. The 15 blocked Villas, one needs-review Villa, media setup, sandbox and signing remain unresolved; do not mark them green or publish a release from unit tests.
