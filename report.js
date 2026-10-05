#!/usr/bin/env node
// Aggregate the per-worker JSONL metrics into a load-test summary.
//
//   node report.js                 # all workers
//   node report.js --since 10m     # last 10 minutes only
//   node report.js --json          # machine-readable
//
// Reads runs/metrics-*.jsonl. Each worker writes its own file, so there is no
// interleaving and no lock contention between workers.

const fs = require("fs");
const path = require("path");

const RUN_DIR = process.env.RUN_DIR || path.join(__dirname, "runs");

function parseSince(arg) {
  if (!arg) return null;
  const m = /^(\d+)([smhd])$/.exec(arg);
  if (!m) throw new Error(`Bad --since value "${arg}". Use e.g. 30s, 10m, 2h.`);
  const mult = {s: 1e3, m: 6e4, h: 36e5, d: 864e5}[m[2]];
  return Date.now() - Number(m[1]) * mult;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function load(sinceTs) {
  if (!fs.existsSync(RUN_DIR)) return [];
  return fs
    .readdirSync(RUN_DIR)
    .filter((f) => /^metrics-.*\.jsonl$/.test(f))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(RUN_DIR, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    )
    .filter((e) => !sinceTs || new Date(e.ts).getTime() >= sinceTs);
}

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const sinceTs = parseSince(sinceIdx === -1 ? null : args[sinceIdx + 1]);
const asJson = args.includes("--json");

const entries = load(sinceTs);
if (!entries.length) {
  console.log(`No metrics found in ${RUN_DIR}. Has the fleet run yet?`);
  process.exit(0);
}

const ok = entries.filter((e) => e.ok);
const failed = entries.filter((e) => !e.ok);
const durations = ok.map((e) => e.durationMs).sort((a, b) => a - b);

const times = entries.map((e) => new Date(e.ts).getTime());
const windowMs = Math.max(1, Math.max(...times) - Math.min(...times));
const throughput = (entries.length / windowMs) * 60000;

// Per-phase percentiles: this is how you find which step degrades first.
const phaseNames = [...new Set(ok.flatMap((e) => Object.keys(e.phases || {})))];
const phaseStats = {};
for (const name of phaseNames) {
  const vals = ok
    .map((e) => e.phases?.[name])
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (vals.length) {
    phaseStats[name] = {
      p50: pct(vals, 50),
      p95: pct(vals, 95),
      max: vals[vals.length - 1],
    };
  }
}

const errorCounts = {};
for (const f of failed) {
  const key = (f.error || "unknown")
    .replace(/\d{3,}/g, "N")
    .slice(0, 90);
  errorCounts[key] = (errorCounts[key] || 0) + 1;
}

const workers = [...new Set(entries.map((e) => e.instance))];

const summary = {
  workers: workers.length,
  totalRuns: entries.length,
  succeeded: ok.length,
  failed: failed.length,
  errorRatePct: Number(((failed.length / entries.length) * 100).toFixed(2)),
  windowSeconds: Number((windowMs / 1000).toFixed(1)),
  runsPerMinute: Number(throughput.toFixed(1)),
  latency: {
    p50: pct(durations, 50),
    p90: pct(durations, 90),
    p95: pct(durations, 95),
    p99: pct(durations, 99),
    max: durations[durations.length - 1] || 0,
  },
  phases: phaseStats,
  topErrors: Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`\nLagos Life load test — ${summary.workers} workers`);
console.log("=".repeat(52));
console.log(`Runs           ${summary.totalRuns}  (${summary.succeeded} ok / ${summary.failed} failed)`);
console.log(`Error rate     ${summary.errorRatePct}%`);
console.log(`Window         ${summary.windowSeconds}s`);
console.log(`Throughput     ${summary.runsPerMinute} runs/min  (full signup→transfer journey)`);
console.log(`\nEnd-to-end latency (successful runs)`);
console.log("-".repeat(52));
for (const k of ["p50", "p90", "p95", "p99", "max"]) {
  console.log(`  ${k.padEnd(5)} ${fmt(summary.latency[k])}`);
}

if (Object.keys(phaseStats).length) {
  console.log(`\nPer-phase latency`);
  console.log("-".repeat(52));
  console.log(`  ${"phase".padEnd(14)}${"p50".padStart(10)}${"p95".padStart(10)}${"max".padStart(10)}`);
  for (const [name, s] of Object.entries(phaseStats)) {
    console.log(
      `  ${name.padEnd(14)}${fmt(s.p50).padStart(10)}${fmt(s.p95).padStart(10)}${fmt(s.max).padStart(10)}`,
    );
  }
}

if (summary.topErrors.length) {
  console.log(`\nTop errors`);
  console.log("-".repeat(52));
  for (const [msg, count] of summary.topErrors) {
    console.log(`  ${String(count).padStart(5)}  ${msg}`);
  }
}
console.log();
