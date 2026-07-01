#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ -n "${NODE_BIN:-}" ]]; then
  NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo "Node.js is required for frontend tests. Set NODE_BIN=/path/to/node." >&2
  exit 1
fi

echo "Running Python unit tests..."
python3 -m unittest discover -s tests

echo "Checking frontend JavaScript syntax..."
"$NODE" --check public/script.js

echo "Running frontend aggregation tests..."
"$NODE" tests/test_frontend_yearly.js

echo "All tests passed."
