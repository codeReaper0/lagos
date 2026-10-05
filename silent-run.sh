#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for i in $(seq 1 10000); do
  printf '=== run %d ===\n' "$i" >>runs.log
  HEADLESS=1 SEND_MONEY=1 node lagos-life.js >>runs.log 2>&1 \
    || echo "run $i FAILED (exit $?)" >>runs.log
done