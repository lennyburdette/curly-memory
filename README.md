# Acuity Availability Monitor

Checks the Acuity scheduling widget on
[realworldfp.com/scheduleameeting](https://www.realworldfp.com/scheduleameeting)
for open slots on **Free Get Acquainted Meeting - 30 Minute Video Meeting**,
once every weekday, and opens a GitHub issue when it finds one.

## How it works

- `.github/workflows/check-acuity-availability.yml` runs on a cron schedule
  (weekdays, 15:00 UTC by default — edit the cron line to change the time)
  and can also be triggered manually from the Actions tab.
- `scripts/check-availability.mjs` drives a headless Chromium via Playwright,
  opens the appointment type, and looks for at least one selectable date
  across up to 3 months.
- The workflow reads the script's `result.json` and:
  - **available** → opens an issue labeled `acuity-availability` (or comments
    on the existing one, so you're not spammed with duplicates).
  - **unavailable** → closes that issue if one was open.
  - **unknown** (selectors didn't match anything recognizable, or the script
    crashed) → opens/updates an issue labeled `monitor-needs-attention` and
    uploads a debug screenshot + `result.json` as a workflow artifact, and
    fails the job so it's visible as a red X in the Actions tab too.

## Local run

```sh
npm install
npx playwright install --with-deps chromium
npm run check
cat result.json
```

## Alerting

This is wired up to open a GitHub issue (uses the default `GITHUB_TOKEN`,
no extra secrets needed) — you'll see it wherever you already get GitHub
notifications (email, mobile app, etc). If you want push/Slack/email/SMS
instead or in addition, swap or extend the "Report result via GitHub issue"
step in the workflow. Some options:

- **ntfy.sh** — no signup; `curl -d "message" ntfy.sh/<your-topic>` for an
  instant phone/desktop push. Store the topic name as a repo secret.
- **Slack** — post to an Incoming Webhook URL stored as a secret.
- **Email via SMTP** — e.g. a Gmail account + App Password, sent with an
  action like `dawidd6/action-send-mail`.
- **Discord** — post to a Discord webhook URL.
- **Pushover / Telegram bot** — other no-fuss push options if you already
  use one of those.

Each just needs a secret or two and an extra step (or a swap of the issue
step) in the workflow — happy to wire one up if you want it added.
