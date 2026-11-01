# Budget review regression

PR #36 review found A -> B -> duplicate A could incorrectly shorten B's budget. Alternative selection now applies the same endpoint/model/credential identity and credential-block checks as execution. Regression requires B to retain 60 seconds and accept a 40-second answer after A failed immediately.

Executed: node --import ./server/tests/_env.mjs --test server/tests/interactive-budget.test.mjs server/tests/llm-cascade.test.mjs
Exit 0, 32 passed, 0 failed. This deterministic test is not a production model proof. Resume at PR #36 checks, then deploy and fresh live gates; do not publish while product acceptance is blocked.
