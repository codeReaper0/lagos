// PM2 load-test fleet for the Lagos Life signup/transfer flow.
//
//   pm2 start ecosystem.config.js                 # default: WORKERS=20
//   WORKERS=5 pm2 start ecosystem.config.js       # smaller fleet
//   pm2 logs lagos-3                              # one worker's log
//   pm2 delete ecosystem.config.js                # tear the fleet down
//   node report.js                                # aggregate results
//
// This replaces the 20 hand-written dry-run-N.sh wrappers. Those clashed for
// four reasons, all fixed here:
//
//   1. `export INSTANCE_ID="${INSTANCE_ID:-N}"` only applied when INSTANCE_ID
//      was unset. PM2 passes its daemon environment to every child, so once
//      INSTANCE_ID existed in the daemon env, ALL 20 workers inherited the same
//      value, wrote the same .dry-run-progress-* file, and clobbered each
//      other's resume point. PM2 `env` below sets it unconditionally.
//   2. Every worker appended to one shared runs.log -> interleaved garbage.
//      Each worker now gets its own out/err log and its own metrics file.
//   3. 20 Chromiums cold-started simultaneously with no memory ceiling. On a
//      typical box that is an OOM fight, which surfaces exactly as the
//      "Target page, context or browser has been closed" errors in runs.log.
//      Fixed with ramp-up jitter (START_JITTER_MS) + max_memory_restart.
//      Tune WORKERS down if your load generator is the bottleneck: you want to
//      be measuring the game, not your laptop.
//   4. Shared /tmp. Each worker gets its own TMPDIR so Chromium profile and
//      crash-dump paths can't collide.

const path = require("path");
const fs = require("fs");

const WORKERS = Number(process.env.WORKERS || 20);
const ROOT = __dirname;
const RUN_DIR = path.join(ROOT, "runs");
const LOG_DIR = path.join(RUN_DIR, "logs");
const TMP_ROOT = path.join(RUN_DIR, "tmp");

fs.mkdirSync(LOG_DIR, {recursive: true});
fs.mkdirSync(TMP_ROOT, {recursive: true});

// Shared knobs. Override at the shell: `TOTAL_RUNS=100 pm2 start ...`
const shared = {
  BASE_URL: process.env.BASE_URL || "https://lagoslife.eliysites.com",
  HEADLESS: process.env.HEADLESS || "1",
  TOTAL_RUNS: process.env.TOTAL_RUNS || "500",
  RECYCLE_EVERY: process.env.RECYCLE_EVERY || "25",
  PW_TIMEOUT: process.env.PW_TIMEOUT || "45000",
  RETRY_ATTEMPTS: process.env.RETRY_ATTEMPTS || "2",

  // Load shaping.
  START_JITTER_MS: process.env.START_JITTER_MS || "15000",
  MIN_RUN_INTERVAL_MS: process.env.MIN_RUN_INTERVAL_MS || "0",
  MAX_CONSECUTIVE_FAILURES: process.env.MAX_CONSECUTIVE_FAILURES || "10",

  // Transfer behaviour. Default exercises the send-money UI without
  // submitting, which is what you want for capacity testing. Flip to
  // "fixed" (with TRANSFER_BUDGET) only when you specifically need to
  // measure the transfer write path.
  TRANSFER_MODE: process.env.TRANSFER_MODE || "none",
  TRANSFER_AMOUNT: process.env.TRANSFER_AMOUNT || "100",
  TRANSFER_BUDGET: process.env.TRANSFER_BUDGET || "0",
  TRANSFER_TARGET: process.env.TRANSFER_TARGET || "codeReaper",

  RUN_DIR,
};

module.exports = {
  apps: Array.from({length: WORKERS}, (_, idx) => {
    const id = idx + 1;
    const tmp = path.join(TMP_ROOT, `w${id}`);
    fs.mkdirSync(tmp, {recursive: true});

    return {
      name: `lagos-${id}`,
      script: "lagos-life.js",
      cwd: ROOT,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Never respawn faster than this; stops a crash-looping worker from
      // turning into an accidental DoS on the target.
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_restarts: 20,
      min_uptime: "30s",
      // A leaking Chromium parent is the usual cause of fleet-wide collapse.
      max_memory_restart: process.env.MAX_MEMORY || "600M",
      kill_timeout: 20000, // let SIGTERM finish the in-flight run
      out_file: path.join(LOG_DIR, `w${id}-out.log`),
      error_file: path.join(LOG_DIR, `w${id}-err.log`),
      merge_logs: true,
      time: true,
      env: {
        ...shared,
        INSTANCE_ID: String(id),
        TMPDIR: tmp,
      },
    };
  }),
};
