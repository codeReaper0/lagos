#!/usr/bin/env bash
# Single-worker smoke test. Use this to validate selectors before starting the
# fleet with `pm2 start ecosystem.config.js`.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# INSTANCE_ID is mandatory and must be unique per worker — this is the setting
# that made the old 20 wrappers collide. "smoke" keeps it clear of the numeric
# IDs the pm2 fleet uses.
export INSTANCE_ID="${INSTANCE_ID:-smoke}"
export HEADLESS="${HEADLESS:-0}"
export TOTAL_RUNS="${TOTAL_RUNS:-1}"
export TRANSFER_MODE="${TRANSFER_MODE:-none}"
export START_JITTER_MS="${START_JITTER_MS:-0}"

exec node lagos-life.js
