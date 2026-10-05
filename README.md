# Lagos Life browser automation

A Playwright automation for macOS that creates a Lagos Life account, customizes the Sim, opens Messages, finds `@codeReaper`, selects the maximum transfer amount, and stops before sending by default.

## Install on a Mac

Requires Node.js 18+.

```bash
cd lagos-life-automation
npm install
npx playwright install chromium
```

## Run

Dry run with a visible browser:

```bash
npm run dry-run
```

The script generates a fresh username, uses a random name, leaves email blank, accepts the 18+ checkbox, selects two random traits, and selects **Max** in Send money. It does **not** submit the transfer unless explicitly enabled.

To submit the transfer:

```bash
npm run send
```

That command performs the final external action. Review the amount in the browser first. The site/account state is external and the script cannot guarantee that a generated username remains unused if the site changes or concurrent signups occur.

For a visible browser while submitting:

```bash
HEADLESS=0 SEND_MONEY=1 node lagos-life.js
```

## Notes

- The password is `Pa$$w0rd!` as requested.
- The script intentionally does not provide an email.
- The selectors use accessible roles and stable IDs where available rather than copying the full Tailwind class strings.
- Website UI changes may require updating selectors.
