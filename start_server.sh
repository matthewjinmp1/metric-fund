#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
FINANCIALS_DB="${FINANCIALS_DB:-/Users/matthewjohnson/Downloads/stock_analysis/AI_stock_scorer/data/financials.db}"

export PORT
export FINANCIALS_DB
export PYTHONDONTWRITEBYTECODE=1

if [[ "${AUTO_RELOAD:-1}" == "1" ]]; then
  python3 -B dev_reloader.py
else
  python3 -B server.py
fi
