#!/usr/bin/env bash
# no `set -e` — we want the loop to keep going after a failed run
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Defaults — override per-wrapper if needed
export INSTANCE_ID="${INSTANCE_ID:-2}"
export SEND_MONEY="${SEND_MONEY:-1}"
export TOTAL_RUNS="${TOTAL_RUNS:-10000}"
export RECYCLE_EVERY="${RECYCLE_EVERY:-25}"
export PW_TIMEOUT="${PW_TIMEOUT:-45000}"
export RETRY_ATTEMPTS="${RETRY_ATTEMPTS:-2}"

# Single call — the JS loop handles all 10000 runs.
node lagos-life.js
exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  echo "lagos-life.js exited with code $exit_code — letting PM2 restart"
  exit "$exit_code"
fi

echo "All runs complete."