#!/usr/bin/env bash
set -Eeuo pipefail

STACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${1:?Usage: auto-audit.sh /absolute/path/to/git-repository}"
REPO="$(realpath "$REPO")"

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v opencode >/dev/null || { echo "OpenCode CLI is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null
if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
  echo "Refusing to run: repository has uncommitted changes." >&2
  exit 1
fi

BRANCH="ai-refactor-audit-$(date -u +%Y%m%dT%H%M%SZ)"
git -C "$REPO" switch -c "$BRANCH"

cd "$REPO"
if [[ -f package.json ]]; then
  npm run --if-present lint
  npm run --if-present typecheck
  npm test --if-present
fi

find . -type d \( -name .git -o -name node_modules -o -name dist -o -name build \) -prune \
  -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print > /tmp/agentforge-audit-ts-files.txt

if [[ -f "$STACK_ROOT/config/opencode.json" ]]; then
  export OPENCODE_CONFIG="$STACK_ROOT/config/opencode.json"
fi

opencode run "Audit this repository's TypeScript files listed in /tmp/agentforge-audit-ts-files.txt. Identify correctness, security, duplication, maintainability and test-coverage issues. Do not edit files, do not run destructive commands, and do not expose secrets. Return prioritized findings with file and line references."

if [[ -f "$STACK_ROOT/.env" ]] && curl --fail --silent http://127.0.0.1:8010/v2/languages >/dev/null; then
  while IFS= read -r doc; do
    [[ -f "$doc" ]] || continue
    text="$(head -c 12000 "$doc" | tr '\n' ' ')"
    curl --fail --silent -X POST http://127.0.0.1:8010/v2/check \
      --data-urlencode "language=de-DE" \
      --data-urlencode "text=$text" >/dev/null
  done < <(find . -maxdepth 3 -type f -name '*.md' -not -path './node_modules/*')
else
  echo "LanguageTool unavailable; documentation check skipped." >&2
fi

echo "Audit complete on branch $BRANCH. No automatic source edits or commit were made."
