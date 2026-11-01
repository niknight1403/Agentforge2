# Staged artifact review corrections

Temporary copied files/directories are writable only inside a private outer staging directory; original source modes remain unchanged. Container identity matches a nonroot host UID, or uses UID 1000 when the host is root. CI tests both cases with writes into existing source directories and nested dist/build outputs.

Artifact traversal has independent rules and preserves nested build/node_modules paths. Symlinks/special files and .env exports are blocked; budgets remain bounded. Exported artifacts include SHA-256 digests. Product readiness revalidates exported content and source fingerprints, so modifying a collected output invalidates build acceptance.

Three local staged-workspace regressions passed, including stale-source rejection, preservation of original source/build files and tamper detection. Real root/nonroot Docker CI and full CI are mandatory before merge/activation. Runtime dependency provisioning and actual Villa product acceptance remain separate; do not mark placeholder products complete.
