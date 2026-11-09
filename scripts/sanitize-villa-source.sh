#!/usr/bin/env bash
set -euo pipefail

root=${1:?usage: sanitize-villa-source.sh <extracted-source-directory>}
[[ -d "$root" ]] || { echo "Source directory not found" >&2; exit 2; }
root=$(cd "$root" && pwd)

# Public release bundles must never contain credentials, private keys, local
# databases/caches, or editor/package backups from a generated Hub workspace.
find "$root" -type d \( -name .git -o -name node_modules -o -name __pycache__ -o -name .next -o -name coverage \) -prune -exec rm -rf -- {} +
find "$root" -type f \( \
  -iname '.env' -o -iname '.env.*' -o -iname '.npmrc' -o -iname '.pypirc' \
  -o -iname 'credentials.json' -o -iname 'credentials.*' -o -iname 'client_secret*.json' \
  -o -iname 'secrets.json' -o -iname 'secrets.yaml' -o -iname 'secrets.yml' \
  -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' -o -iname '*.keystore' \
  -o -iname '*.db' -o -iname '*.sqlite' -o -iname '*.sqlite3' \
  -o -iname '*.bak' -o -iname '*.bak-*' -o -iname '*.orig' -o -iname '*.old' -o -iname '*.swp' \
  -o -iname '*.log' -o -iname '.ds_store' \
\) -delete

# Fail closed if known secret-bearing filenames remain. Never print file contents.
if find "$root" -type f \( \
  -iname '.env' -o -iname '.env.*' -o -iname '.npmrc' -o -iname '.pypirc' \
  -o -iname 'credentials.json' -o -iname 'credentials.*' -o -iname 'client_secret*.json' \
  -o -iname 'secrets.json' -o -iname 'secrets.yaml' -o -iname 'secrets.yml' \
  -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' -o -iname '*.keystore' \
  -o -iname '*.db' -o -iname '*.sqlite' -o -iname '*.sqlite3' \
\) -print -quit | grep -q .; then
  echo "Refusing public release: sensitive filename remains in source bundle." >&2
  exit 1
fi

# Guard against common accidentally committed token/private-key formats. Redirect
# grep output so neither the matching line nor its path can leak into Actions logs.
if grep -RIlE --binary-files=without-match -- \
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}' \
  "$root" >/dev/null 2>&1; then
  echo "Refusing public release: credential-like content remains in source bundle." >&2
  exit 1
fi

echo "Sanitized public source bundle; sensitive files, local data and backups removed."
