const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------
// Point BASE_URL at a staging/load-test environment wherever possible. Running
// a 20-worker signup storm at production is how you find out your own game is
// down, and the signups you create are real rows someone has to clean up.
const URL = process.env.BASE_URL || "https://lagoslife.eliysites.com";
const PASSWORD = process.env.SIM_PASSWORD || "Pa$$w0rd!";
const TARGET = process.env.TRANSFER_TARGET || "codeReaper";

// Worker identity. Every per-instance file (progress, metrics, screenshots) is
// keyed off this, so a collision here is what makes N workers trample each
// other. Fail loudly instead of silently defaulting to "0" for all of them.
const INSTANCE_ID = process.env.INSTANCE_ID;
if (!INSTANCE_ID || !/^[\w.-]+$/.test(INSTANCE_ID)) {
  console.error(
    "FATAL: INSTANCE_ID must be set to a unique [A-Za-z0-9_.-] value per worker.\n" +
      "       Use `pm2 start ecosystem.config.js` which assigns these for you.",
  );
  process.exit(2);
}

// ---------- Transfer behaviour ----------
// TRANSFER_MODE: "none"  -> exercise the send-money sheet, never submit (default)
//                "fixed" -> submit TRANSFER_AMOUNT per run
//                "max"   -> submit the whole balance
// "max" against a single recipient across thousands of generated accounts is
// economy manipulation, not load testing, so it is gated behind an explicit
// opt-in and a hard budget (TRANSFER_BUDGET: max transfers per worker).
const TRANSFER_MODE = (process.env.TRANSFER_MODE || "none").toLowerCase();
const TRANSFER_AMOUNT = Number(process.env.TRANSFER_AMOUNT || 100);
const TRANSFER_BUDGET = Number(process.env.TRANSFER_BUDGET || 0);
if (!["none", "fixed", "max"].includes(TRANSFER_MODE)) {
  console.error(`FATAL: unknown TRANSFER_MODE "${TRANSFER_MODE}".`);
  process.exit(2);
}

const HEADLESS = process.env.HEADLESS !== "0";
const KEEP_OPEN = process.env.KEEP_OPEN === "1";
const SINGLE_PROC = process.env.SINGLE_PROCESS === "1";
const TOTAL_RUNS = Number(process.env.TOTAL_RUNS || 10000);
const RECYCLE_EVERY = Number(process.env.RECYCLE_EVERY || 25);
const PW_TIMEOUT = Number(process.env.PW_TIMEOUT || 45000);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 2);
const DEBUG_HTML = process.env.DEBUG_HTML === "1";

// ---------- Load shaping ----------
// Stagger worker start so 20 Chromiums don't cold-start into the same second,
// and keep a floor on run spacing so the target sees a steady arrival rate
// instead of a thundering herd.
const START_JITTER_MS = Number(process.env.START_JITTER_MS || 15000);
const MIN_RUN_INTERVAL_MS = Number(process.env.MIN_RUN_INTERVAL_MS || 0);
// Circuit breaker: stop hammering a target that is already failing.
const MAX_CONSECUTIVE_FAILURES = Number(
  process.env.MAX_CONSECUTIVE_FAILURES || 10,
);

// Required after config validation so a misconfigured worker reports the real
// problem instead of a MODULE_NOT_FOUND stack.
const {chromium} = require("playwright");

const RUN_DIR = process.env.RUN_DIR || path.join(__dirname, "runs");
const PROGRESS_FILE = path.join(RUN_DIR, `progress-${INSTANCE_ID}`);
const METRICS_FILE = path.join(RUN_DIR, `metrics-${INSTANCE_ID}.jsonl`);
const FAILURE_DIR = path.join(RUN_DIR, "failures");

const COOKIE_DIALOG_SELECTOR = '[role="dialog"][aria-label="Cookies"]';

// ---------- Data ----------
const names = [
  "Wylie Henry",
  "Tolu Adebayo",
  "Amaka Okafor",
  "Chidi Mensah",
  "Kemi Balogun",
  "Dayo Adeyemi",
  "Nneka Eze",
  "Femi Lawal",
];

const traits = [
  "Hustler",
  "Foodie",
  "Owambe Spirit",
  "Gym Rat",
  "Smooth Talker",
  "Lazy Bone",
  "Clean Pikin",
  "Night Crawler",
  "Tech Bro or Sis",
  "Musical",
];

// ---------- Chromium launch flags ----------
const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion",
  "--disable-component-update",
  "--disable-default-apps",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-service-autorun",
  "--password-store=basic",
  "--use-mock-keychain",
  "--js-flags=--max-old-space-size=192",
];

if (SINGLE_PROC) LAUNCH_ARGS.push("--single-process", "--no-zygote");

// ---------- Resource blocking ----------
const BLOCKED_TYPES = new Set(["image", "media", "font"]);

// ---------- Helpers ----------
function uniqueUsername() {
  return `sim${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`.slice(
    0,
    20,
  );
}

function log(...args) {
  console.log(`[inst ${INSTANCE_ID}] [${new Date().toISOString()}]`, ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Metrics ----------
// One JSON object per run, appended to a per-instance file. Per-instance is the
// point: 20 workers appending to one shared log is what produced the
// interleaved, unreadable runs.log. `node report.js` aggregates these.
function recordMetric(entry) {
  try {
    fs.mkdirSync(RUN_DIR, {recursive: true});
    fs.appendFileSync(
      METRICS_FILE,
      JSON.stringify({instance: INSTANCE_ID, ts: new Date().toISOString(), ...entry}) +
        "\n",
    );
  } catch (e) {
    log(`Could not write metric: ${e.message}`);
  }
}

// Phase timings turn this from a bot into a load test: you find out *which*
// step degrades under concurrency, not just that something timed out.
function makeTimer() {
  const phases = {};
  let mark = Date.now();
  return {
    phase(name) {
      const now = Date.now();
      phases[name] = now - mark;
      mark = now;
    },
    phases: () => phases,
  };
}

async function blockHeavy(route) {
  const type = route.request().resourceType();
  if (BLOCKED_TYPES.has(type)) return route.abort();
  return route.continue();
}

async function clickButton(page, text, options = {}) {
  const button = page
    .getByRole("button", {name: text, exact: options.exact ?? true})
    .last();
  await button.waitFor({
    state: "visible",
    timeout: options.timeout ?? PW_TIMEOUT,
  });
  await button.click({timeout: options.timeout ?? PW_TIMEOUT});
}

async function clickContinue(page) {
  await clickButton(page, "Continue");
}

async function withRetry(fn, label = "action", attempts = RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log(`${label} attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

async function saveFailureScreenshot(page, runIndex) {
  try {
    if (!page || page.isClosed()) return null;
    fs.mkdirSync(FAILURE_DIR, {recursive: true});
    const shot = path.join(
      FAILURE_DIR,
      `inst${INSTANCE_ID}-run${runIndex}-${Date.now()}.png`,
    );
    await page.screenshot({path: shot, fullPage: true});
    log(`Failure screenshot saved: ${shot}`);
    return shot;
  } catch (e) {
    log(`Could not save failure screenshot: ${e.message}`);
    return null;
  }
}

// ---------- Cookie banner ----------
async function dismissCookieBanner(page) {
  const dialog = page.locator(COOKIE_DIALOG_SELECTOR);
  const appeared = await dialog
    .waitFor({state: "visible", timeout: 3000})
    .then(() => true)
    .catch(() => false);

  if (!appeared) return;

  const candidates = [
    /^Accept( all)?$/i,
    /^I agree$/i,
    /^Agree$/i,
    /^Got it$/i,
    /^OK$/i,
    /^Allow all$/i,
    /^Reject( all)?$/i,
  ];

  for (const label of candidates) {
    const btn = dialog.getByRole("button", {name: label}).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({timeout: 5000}).catch(() => {});
      log(`Dismissed cookie banner via "${label}".`);
      await dialog.waitFor({state: "hidden", timeout: 5000}).catch(() => {});
      return;
    }
  }

  await page
    .addStyleTag({
      content: `${COOKIE_DIALOG_SELECTOR}{display:none !important;}`,
    })
    .catch(() => {});
  log("Hid cookie banner via CSS fallback.");
}

function installCookieKiller(page) {
  const css = `${COOKIE_DIALOG_SELECTOR}{display:none !important;}`;
  page.on("domcontentloaded", () => {
    page.addStyleTag({content: css}).catch(() => {});
  });
}

// ---------- Debug helper: dump every button + input on the page ----------
async function dumpInteractive(page, label) {
  if (!DEBUG_HTML) return;
  try {
    const info = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")].map((b) => ({
        text: (b.textContent || "").trim().slice(0, 80),
        disabled: b.disabled,
        visible: b.offsetParent !== null,
      }));
      const inputs = [...document.querySelectorAll("input")].map((i) => ({
        name: i.name,
        type: i.type,
        value: i.value,
        placeholder: i.placeholder,
        visible: i.offsetParent !== null,
      }));
      const bodyText = (document.body.innerText || "").slice(0, 800);
      return {buttons, inputs, bodyText};
    });
    log(`--- ${label} ---`);
    log("BUTTONS:", JSON.stringify(info.buttons, null, 2));
    log("INPUTS:", JSON.stringify(info.inputs, null, 2));
    log("BODY TEXT (first 800):", info.bodyText);
  } catch (e) {
    log(`dumpInteractive failed: ${e.message}`);
  }
}

// ---------- Send money ----------
// `transferState` is owned by the caller so the per-worker budget survives
// across runs within a process.
const transferState = {submitted: 0};

async function sendMaxAmount(page) {
  // Snapshot the page BEFORE clicking Max so we can compare.
  const beforeSnapshot = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].map((i) => i.value);
    const text = document.body.innerText || "";
    return {inputs, text};
  });

  // 1) Set the amount.
  if (TRANSFER_MODE === "fixed") {
    const amountInput = page
      .locator('input[type="number"], input[inputmode="numeric"], input')
      .first();
    await amountInput.waitFor({state: "visible", timeout: PW_TIMEOUT});
    await amountInput.fill(String(TRANSFER_AMOUNT));
    log(`Entered fixed amount ${TRANSFER_AMOUNT}.`);
  } else {
    const maxBtn = page.getByRole("button", {name: "Max", exact: true}).first();
    await maxBtn.waitFor({state: "visible", timeout: PW_TIMEOUT});
    await maxBtn.scrollIntoViewIfNeeded();
    await maxBtn.click({timeout: PW_TIMEOUT});
    log("Clicked Max.");
  }

  // 2) Wait until SOMETHING changed (input value OR body text) — do NOT
  //    assume the amount lives in an <input>.
  const changed = await page
    .waitForFunction(
      (before) => {
        const inputsNow = [...document.querySelectorAll("input")].map(
          (i) => i.value,
        );
        const textNow = document.body.innerText || "";
        const inputsChanged =
          JSON.stringify(inputsNow) !== JSON.stringify(before.inputs);
        const textChanged = textNow !== before.text;
        return inputsChanged || textChanged;
      },
      beforeSnapshot,
      {timeout: 15000},
    )
    .then(() => true)
    .catch(() => false);

  log(
    changed
      ? "Page state changed after Max."
      : "⚠️ No visible change after Max.",
  );

  // 3) Log whatever the amount now looks like (best-effort, for debugging)
  await dumpInteractive(page, "AFTER MAX");

  // 4) Small settle for React
  await page.waitForTimeout(500).catch(() => {});

  // 5) Find the Send button — try multiple patterns in order.
  const sendPatterns = [/Send .* · fee/i, /^Send ₦/i, /Send money/i, /^Send$/i];

  let sendButton = null;
  for (const pattern of sendPatterns) {
    const candidate = page.getByRole("button", {name: pattern}).first();
    const visible = await candidate.isVisible().catch(() => false);
    if (visible) {
      sendButton = candidate;
      log(`Send button matched pattern: ${pattern}`);
      break;
    }
  }

  if (!sendButton) {
    // Last-ditch: any enabled button whose text contains "send"
    const fallback = page
      .locator("button")
      .filter({hasText: /send/i})
      .filter({hasNotText: /send money/i}) // avoid re-matching the opening button
      .first();
    if (await fallback.isVisible().catch(() => false)) {
      sendButton = fallback;
      log("Send button matched fallback (any button containing 'send').");
    }
  }

  if (!sendButton) {
    throw new Error("Could not find the Send button after clicking Max.");
  }

  await sendButton.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await sendButton.scrollIntoViewIfNeeded();

  if (TRANSFER_MODE === "none") {
    log("TRANSFER_MODE=none: amount selected, send button reached, NOT submitted.");
    return;
  }

  if (TRANSFER_BUDGET > 0 && transferState.submitted >= TRANSFER_BUDGET) {
    log(
      `Transfer budget reached (${transferState.submitted}/${TRANSFER_BUDGET}) — ` +
        `exercising the flow without submitting.`,
    );
    return;
  }

  // 6) Click Send and wait for the POST.
  const [response] = await Promise.all([
    page
      .waitForResponse(
        (r) =>
          /send|transfer|pay|gift/i.test(r.url()) &&
          r.request().method() === "POST",
        {timeout: PW_TIMEOUT},
      )
      .catch(() => null),
    sendButton.click({timeout: PW_TIMEOUT}),
  ]);

  transferState.submitted++;

  if (response) {
    log(`Send API status: ${response.status()} → ${response.url()}`);
  } else {
    log("⚠️ No send API response captured — the click may still have worked.");
  }

  // Give the UI a moment to show success/confirmation.
  await page.waitForTimeout(1500).catch(() => {});
  await dumpInteractive(page, "AFTER SEND");

  log(
    `Completed: submitted ${
      TRANSFER_MODE === "max" ? "the maximum available amount" : TRANSFER_AMOUNT
    } to @${TARGET} (${transferState.submitted}${
      TRANSFER_BUDGET > 0 ? `/${TRANSFER_BUDGET}` : ""
    } this worker).`,
  );
}

// ---------- One iteration ----------
async function runOnce(page, timer) {
  await page.goto(URL, {waitUntil: "domcontentloaded"});
  await dismissCookieBanner(page);
  timer.phase("landing");

  await clickButton(page, "Sign up free");

  const name = names[Math.floor(Math.random() * names.length)];
  const username = uniqueUsername();
  await page.locator("#signup-name").fill(name);
  await page.locator('input[name="username"]').fill(username);
  await page.locator("#signup-password").fill(PASSWORD);
  await page.locator('#signup-adult input[type="checkbox"]').check();
  await page.getByRole("button", {name: "Sign up · it's free"}).click();
  timer.phase("signup");

  await page.getByRole("button", {name: "Woman", exact: true}).click();
  await page.getByRole("button", {name: "Braids", exact: true}).click();
  await page.getByRole("button", {name: "Owambe", exact: true}).click();
  await page.getByRole("button", {name: "Ankara", exact: true}).click();
  await clickContinue(page);

  const selectedTraits = traits.sort(() => Math.random() - 0.5).slice(0, 2);
  for (const trait of selectedTraits) {
    const card = page.locator("button").filter({hasText: trait}).first();
    await card.waitFor({state: "visible", timeout: PW_TIMEOUT});
    await card.click();
  }

  const traitContinue = page
    .getByRole("button", {name: "Continue", exact: true})
    .last();
  await traitContinue.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await page.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll("button")];
      const button = buttons.find((b) => b.textContent?.trim() === "Continue");
      return button && !button.disabled;
    },
    null,
    {timeout: PW_TIMEOUT},
  );
  await traitContinue.click();

  await clickContinue(page);

  const moveButton = page
    .getByRole("button", {name: /Move into your|Choose where to live/i})
    .last();
  await moveButton.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await moveButton.scrollIntoViewIfNeeded();
  await moveButton.click();

  const moveInButton = page
    .getByRole("button", {name: "Move in", exact: true})
    .last();
  try {
    await moveInButton.waitFor({state: "visible", timeout: 10000});
    await moveInButton.scrollIntoViewIfNeeded();
    await moveInButton.click();
  } catch (error) {
    if (!/TimeoutError/.test(error.name || "")) throw error;
  }

  timer.phase("onboarding");

  await clickButton(page, "Phone");

  const messagesButton = page
    .locator("button")
    .filter({hasText: "Messages"})
    .last();
  await messagesButton.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await messagesButton.scrollIntoViewIfNeeded();
  await messagesButton.click();

  const search = page.locator("input").first();
  await search.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await search.fill(TARGET);

  const targetButton = page
    .locator("button")
    .filter({hasText: new RegExp(`@${TARGET}`, "i")})
    .first();
  await targetButton.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await targetButton.scrollIntoViewIfNeeded();
  await targetButton.click();

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) =>
        /Send money/i.test(b.textContent || ""),
      ),
    null,
    {timeout: PW_TIMEOUT},
  );

  timer.phase("messages");

  await withRetry(() => clickButton(page, "💸 Send money"), "open send-money");

  // Give the send-money sheet time to render before interacting.
  await page.waitForTimeout(800).catch(() => {});
  await dumpInteractive(page, "SEND-MONEY SHEET OPENED");

  // ---- Amount + Send ----
  await sendMaxAmount(page);
  timer.phase("transfer");
}

// ---------- Progress ----------
function readProgress() {
  try {
    return Number(fs.readFileSync(PROGRESS_FILE, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function writeProgress(n) {
  fs.mkdirSync(RUN_DIR, {recursive: true});
  // Atomic: a pm2 restart mid-write otherwise leaves a truncated progress file
  // and the worker silently restarts from 0.
  const tmp = `${PROGRESS_FILE}.tmp`;
  fs.writeFileSync(tmp, String(n));
  fs.renameSync(tmp, PROGRESS_FILE);
}

// ---------- Main loop ----------
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log(`${sig} received — finishing current run then exiting.`);
  });
}

async function main() {
  fs.mkdirSync(RUN_DIR, {recursive: true});

  const start = readProgress() + 1;
  if (start > TOTAL_RUNS) {
    log(`All ${TOTAL_RUNS} runs completed. Delete ${PROGRESS_FILE} to restart.`);
    return;
  }

  log(
    `Starting at run ${start}/${TOTAL_RUNS} | recycle=${RECYCLE_EVERY} | ` +
      `headless=${HEADLESS} | singleProcess=${SINGLE_PROC} | ` +
      `transferMode=${TRANSFER_MODE} | transferBudget=${TRANSFER_BUDGET || "unlimited"} | ` +
      `target=@${TARGET} | base=${URL} | pwTimeout=${PW_TIMEOUT}ms`,
  );

  // Ramp-up. Without this every worker cold-starts a Chromium in the same
  // second: the box thrashes on RAM and the target gets a step-function of
  // signups. Both show up as the "clash" (browser closed / timeouts).
  if (START_JITTER_MS > 0) {
    const delay = Math.floor(Math.random() * START_JITTER_MS);
    log(`Ramp-up delay ${delay}ms.`);
    await sleep(delay);
  }

  let browser = null;
  let consecutiveFailures = 0;

  const launch = async () => {
    browser = await chromium.launch({headless: HEADLESS, args: LAUNCH_ARGS});
    log("Browser launched.");
  };

  const closeBrowser = async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      log("Browser closed.");
    }
  };

  try {
    for (let i = start; i <= TOTAL_RUNS; i++) {
      if (shuttingDown) {
        log("Shutting down cleanly.");
        break;
      }

      const runStarted = Date.now();
      if (!browser) await launch();

      const context = await browser.newContext({
        viewport: {width: 640, height: 480},
      });

      const timer = makeTimer();
      let page;
      try {
        page = await context.newPage();
        page.setDefaultTimeout(PW_TIMEOUT);
        page.setDefaultNavigationTimeout(PW_TIMEOUT);
        await page.route("**/*", blockHeavy);
        installCookieKiller(page);

        log(`=== Run ${i}/${TOTAL_RUNS} ===`);
        await runOnce(page, timer);
        log(`=== Run ${i} finished ===`);

        consecutiveFailures = 0;
        writeProgress(i);
        recordMetric({
          run: i,
          ok: true,
          durationMs: Date.now() - runStarted,
          phases: timer.phases(),
        });
      } catch (err) {
        // A single failed run is data, not a reason to kill the worker and let
        // pm2 respawn a fresh Chromium. Record it and carry on; the circuit
        // breaker below handles the case where the target is genuinely down.
        consecutiveFailures++;
        log(`Run ${i} FAILED (${consecutiveFailures} in a row): ${err.message}`);
        const shot = await saveFailureScreenshot(page, i);
        recordMetric({
          run: i,
          ok: false,
          durationMs: Date.now() - runStarted,
          phases: timer.phases(),
          error: err.message,
          screenshot: shot,
        });
        writeProgress(i);

        // Recycle the browser: most failures here leave a wedged context.
        await closeBrowser();

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(
            `Circuit breaker: ${consecutiveFailures} consecutive failures. ` +
              `Backing off rather than hammering a target that is already failing.`,
          );
          throw err;
        }
        // Exponential backoff, capped, so a struggling target gets room.
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures, 5)));
      } finally {
        if (!KEEP_OPEN) {
          await sleep(500);
          await context.close().catch(() => {});
        }
      }

      // Hold the per-worker arrival rate steady.
      if (MIN_RUN_INTERVAL_MS > 0) {
        const elapsed = Date.now() - runStarted;
        if (elapsed < MIN_RUN_INTERVAL_MS) await sleep(MIN_RUN_INTERVAL_MS - elapsed);
      }

      if (i % RECYCLE_EVERY === 0) await closeBrowser();
    }
  } finally {
    if (!KEEP_OPEN) await closeBrowser();
  }

  log(`All runs complete for instance ${INSTANCE_ID}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
