const {chromium} = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------
const URL = "https://lagoslife.eliysites.com";
const PASSWORD = "Pa$$w0rd!";
const TARGET = "codeReaper";

const SEND_MONEY = process.env.SEND_MONEY === "1";
const HEADLESS = process.env.HEADLESS !== "0";
const KEEP_OPEN = process.env.KEEP_OPEN === "1";
const SINGLE_PROC = process.env.SINGLE_PROCESS === "1";
const TOTAL_RUNS = Number(process.env.TOTAL_RUNS || 10000);
const RECYCLE_EVERY = Number(process.env.RECYCLE_EVERY || 25);
const INSTANCE_ID = process.env.INSTANCE_ID || "0";
const PW_TIMEOUT = Number(process.env.PW_TIMEOUT || 45000);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 2);
const DEBUG_HTML = process.env.DEBUG_HTML === "1";

const PROGRESS_FILE = path.join(__dirname, `.dry-run-progress-${INSTANCE_ID}`);
const FAILURE_DIR = path.join(__dirname, "failures");

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

// ---------- Send money (fixed) ----------
async function sendMaxAmount(page) {
  // Snapshot the page BEFORE clicking Max so we can compare.
  const beforeSnapshot = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].map((i) => i.value);
    const text = document.body.innerText || "";
    return {inputs, text};
  });

  // 1) Click Max
  const maxBtn = page.getByRole("button", {name: "Max", exact: true}).first();
  await maxBtn.waitFor({state: "visible", timeout: PW_TIMEOUT});
  await maxBtn.scrollIntoViewIfNeeded();
  await maxBtn.click({timeout: PW_TIMEOUT});
  log("Clicked Max.");

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

  if (!SEND_MONEY) {
    log("DRY RUN: Max amount selected; money was NOT sent.");
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

  if (response) {
    log(`Send API status: ${response.status()} → ${response.url()}`);
  } else {
    log("⚠️ No send API response captured — the click may still have worked.");
  }

  // Give the UI a moment to show success/confirmation.
  await page.waitForTimeout(1500).catch(() => {});
  await dumpInteractive(page, "AFTER SEND");

  log(`Completed: sent the maximum available amount to @${TARGET}.`);
}

// ---------- One iteration ----------
async function runOnce(page) {
  await page.goto(URL, {waitUntil: "domcontentloaded"});
  await dismissCookieBanner(page);

  await clickButton(page, "Sign up free");

  const name = names[Math.floor(Math.random() * names.length)];
  const username = uniqueUsername();
  await page.locator("#signup-name").fill(name);
  await page.locator('input[name="username"]').fill(username);
  await page.locator("#signup-password").fill(PASSWORD);
  await page.locator('#signup-adult input[type="checkbox"]').check();
  await page.getByRole("button", {name: "Sign up · it's free"}).click();

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

  await withRetry(() => clickButton(page, "💸 Send money"), "open send-money");

  // Give the send-money sheet time to render before interacting.
  await page.waitForTimeout(800).catch(() => {});
  await dumpInteractive(page, "SEND-MONEY SHEET OPENED");

  // ---- Max + Send (fixed) ----
  await sendMaxAmount(page);
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
  fs.writeFileSync(PROGRESS_FILE, String(n));
}

// ---------- Main loop ----------
async function main() {
  const start = readProgress() + 1;
  if (start > TOTAL_RUNS) {
    log(
      `All ${TOTAL_RUNS} runs completed. Delete ${PROGRESS_FILE} to restart.`,
    );
    return;
  }

  log(
    `Starting at run ${start}/${TOTAL_RUNS} | recycle=${RECYCLE_EVERY} | ` +
      `headless=${HEADLESS} | singleProcess=${SINGLE_PROC} | sendMoney=${SEND_MONEY} | ` +
      `pwTimeout=${PW_TIMEOUT}ms | debugHtml=${DEBUG_HTML}`,
  );

  let browser = null;

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
      if (!browser) await launch();

      const context = await browser.newContext({
        viewport: {width: 640, height: 480},
      });

      let page;
      try {
        page = await context.newPage();
        page.setDefaultTimeout(PW_TIMEOUT);
        page.setDefaultNavigationTimeout(PW_TIMEOUT);
        await page.route("**/*", blockHeavy);
        installCookieKiller(page);

        log(`=== Run ${i}/${TOTAL_RUNS} ===`);
        await runOnce(page);
        log(`=== Run ${i} finished ===`);
        writeProgress(i);
      } catch (err) {
        log(`Run ${i} FAILED: ${err.message}`);
        await saveFailureScreenshot(page, i);
        throw err;
      } finally {
        if (!KEEP_OPEN) {
          await new Promise((r) => setTimeout(r, 500));
          await context.close().catch(() => {});
        }
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
