# Interactive inference budget

Baseline: 86cecf3613611e924f9d10eb4fe4dc141892b9a6

Observed production Master probe: HTTP 503 after 60.3 seconds, first local endpoint BUSY and second endpoint TIMEOUT. A single inference exhausted the request deadline before another local endpoint was attempted.

Interactive local attempts now reserve half the remaining deadline when a different local endpoint remains. Background generation and the last endpoint retain their existing limits. No concurrency, provider credentials, paid routes or Villa state changes.

Verification: node --import ./server/tests/_env.mjs --test server/tests/interactive-budget.test.mjs server/tests/llm-cascade.test.mjs — exit 0, 31 passed. Deterministic clock regression verifies inference timeout then successful alternative, not merely queue timeout. This is a regression fixture, not a production model response.

Resume: finish PR checks, integrate without competing deployment, then fresh real Master and product acceptance. No release approval until production and artifact gates pass.
