# Lagos Life — signup/transfer load test

A Playwright-driven load test for the Lagos Life onboarding journey. Each run
drives one full user journey: landing → signup → Sim customisation → move in →
Phone → Messages → find a recipient → open Send money. It measures how that
journey behaves under concurrency.

> **Run this against staging.** Every run creates a real account on whatever
> `BASE_URL` points at. Pointing a 20-worker fleet at production means real rows
> in your real database and real load on real players. Use a staging
> environment, or coordinate a window with whoever operates the site.

## Install

Node.js 18+.

```bash
npm install
npx playwright install chromium
npm install -g pm2     # or use the local devDependency
```

## Smoke test one worker first

Always validate selectors with a single visible browser before starting a
fleet — a broken selector across 20 workers is just 20x the noise.

```bash
npm run smoke                      # 1 run, visible browser, nothing submitted
BASE_URL=https://staging.example npm run smoke
```

## Run the fleet

```bash
npm run fleet:start                            # 20 workers
WORKERS=5 TOTAL_RUNS=100 pm2 start ecosystem.config.js
pm2 ls
pm2 logs lagos-3                               # one worker
npm run fleet:stop
```

## Read the results

```bash
npm run report
node report.js --since 10m
node report.js --json
```

Output gives throughput, end-to-end latency percentiles, and **per-phase**
percentiles, so you can see which step degrades first as you add workers —
usually the thing you actually want to know.

```
Runs           240  (196 ok / 44 failed)
Error rate     18.33%
Throughput     27.1 runs/min

  phase                p50       p95       max
  landing            501ms     686ms     700ms
  signup             1.46s     2.03s     2.07s
  onboarding         1.65s     2.05s     2.10s
```

### Finding the ceiling

Ramp in steps rather than jumping to 20. Run each step long enough to be
meaningful, record the numbers, then increase:

```bash
for w in 2 5 10 20; do
  WORKERS=$w TOTAL_RUNS=50 pm2 start ecosystem.config.js
  # wait for completion, then:
  node report.js --json > "results-${w}w.json"
  pm2 delete ecosystem.config.js
done
```

The capacity ceiling is the worker count where p95 starts climbing sharply or
the error rate leaves the noise floor. Watch the server's own CPU/memory/DB
metrics at the same time — client-side timings alone can't tell you *why*.

Also confirm your load generator isn't the bottleneck: 20 Chromium instances is
several GB of RAM. If the box is swapping, you're measuring your laptop.

## Configuration

Set in `ecosystem.config.js` or override at the shell.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | production URL | **Point at staging.** |
| `WORKERS` | `20` | Fleet size (ecosystem only). |
| `INSTANCE_ID` | *(required)* | Unique per worker. Keys progress/metrics/screenshots. |
| `TOTAL_RUNS` | `500` | Runs per worker. |
| `HEADLESS` | `1` | `0` for a visible browser. |
| `RECYCLE_EVERY` | `25` | Relaunch Chromium every N runs. |
| `START_JITTER_MS` | `15000` | Random ramp-up delay per worker. |
| `MIN_RUN_INTERVAL_MS` | `0` | Floor on run spacing — throttles arrival rate. |
| `MAX_CONSECUTIVE_FAILURES` | `10` | Circuit breaker. |
| `MAX_MEMORY` | `600M` | pm2 restarts a worker above this. |
| `PW_TIMEOUT` | `45000` | Playwright timeout (ms). |

### Transfer behaviour

| `TRANSFER_MODE` | Behaviour |
| --- | --- |
| `none` *(default)* | Opens Send money, selects an amount, **does not submit**. |
| `fixed` | Submits `TRANSFER_AMOUNT` per run. |
| `max` | Submits the entire balance. |

`TRANSFER_BUDGET` caps how many transfers a single worker will submit (`0` =
unlimited); once reached, the worker still exercises the UI but stops
submitting.

Testing the send endpoint:

```bash
npm run smoke:transfer     # 1 worker, 1 real transfer — verify it works
npm run fleet:transfer     # 20 workers x 25 transfers each, fixed amount
npm run report             # status-code mix + send-API latency
```

The report then includes a transfer section:

```
Transfer endpoint (500/500 submitted)
  200               412  (82.4%)
  429                76  (15.2%)
  500                12  (2.4%)
  API latency    p50 439ms   p95 2.78s   max 3.05s
```

A rising share of 429/5xx there is the finding — it tells you the send path,
not the signup path, is what gives first under load. `429` is logged explicitly
rather than treated as a run failure, since rate limiting is a correct
response, not a bug.

Default is `none` because capacity testing the signup funnel doesn't require
completed transfers. If you need to measure the transfer write path, use
`fixed` with a `TRANSFER_BUDGET` — that gives you the same latency data without
funnelling the balance of every generated account into one recipient, which
distorts the game economy and is indistinguishable from abuse in your own
server logs.

## Output layout

Everything lands in `runs/` (gitignored):

```
runs/
  logs/w3-out.log           per-worker stdout
  logs/w3-err.log           per-worker stderr
  metrics-3.jsonl           one JSON object per run
  progress-3                resume point (atomic write)
  failures/inst3-run88-*.png
  tmp/w3/                   per-worker TMPDIR
```

## Why the old 20 wrappers clashed

The previous setup was `dry-run-1.sh` … `dry-run-20.sh` started with
`pm2 start bash --name "l${i}" -- -c "./dry-run-${i}.sh"`. Four distinct
collisions, all fixed:

1. **Shared instance ID.** Each wrapper used
   `export INSTANCE_ID="${INSTANCE_ID:-N}"`, which only applies when the
   variable is *unset*. pm2 passes its daemon environment to every child, so as
   soon as `INSTANCE_ID` existed in that environment all 20 workers took the
   same value — one shared `.dry-run-progress-*` file, each worker overwriting
   the others' resume point, and failure screenshots overwriting each other.
   `INSTANCE_ID` is now mandatory, validated at startup, and set
   unconditionally by `ecosystem.config.js`.
2. **Shared log file.** Every worker appended to one `runs.log`, producing the
   interleaved `=== run 7 ===` / `=== run 1 ===` mess. Per-worker logs and
   per-worker metrics files now.
3. **Simultaneous cold start.** 20 Chromiums launching in the same second with
   no memory ceiling — that's the source of the
   `Target page, context or browser has been closed` errors. Fixed with
   ramp-up jitter, `max_memory_restart`, and browser recycling.
4. **Shared `/tmp`.** Each worker now gets its own `TMPDIR`.

Additionally, a single failed run used to throw and kill the worker so pm2
would respawn a fresh Chromium — expensive, and it masked the failure. Failures
are now recorded as data, the browser is recycled, and backoff applies; the
circuit breaker stops the fleet if a target is genuinely failing.

## Notes

- Selectors use accessible roles and stable IDs; UI changes may require updates.
- Failure screenshots are written to `runs/failures/` for triage.
- Workers handle `SIGTERM` gracefully (`pm2 stop` finishes the in-flight run).
