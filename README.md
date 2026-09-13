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
  opens the appointment type, and always checks all 3 months (it doesn't
  stop at the first one with an opening), screenshotting each month as it
  goes (`acuity-check-month-1.png`, `-month-2.png`, `-month-3.png`) so every
  month it looked at can be visually checked against what it reported, not
  just the final one. It logs every step (navigation, frame detection,
  which selector matched, the visible month label, and — critically — a
  sample of every calendar-day element it considered with its text,
  aria-label and disabled state, so a wrong "available"/"unavailable" call
  can be diagnosed straight from the run log) to stdout, so the Actions run
  log tells the full story of what happened on a given run, not just the
  final verdict.
  - Day-cell detection: a real day-of-month control almost always shows
    just the day number as its entire visible text (e.g. "14"), which
    reliably separates it from prev/next/today/month controls that use
    icons or words — even when those controls live inside the same
    calendar-classed container (that mixing is what caused an early
    version of this script to misreport "available" when the real
    calendar showed no open days: two enabled nav-ish elements were
    getting counted as if they were dates). Falls back to older
    class-based selectors if a widget doesn't render bare day numbers.
- `scripts/report-issue.sh` reads `result.json` and reports it via `gh
  issue create`/`comment`/`close`, attaching every month's screenshot with
  `gh`'s `--attach` flag ([media in issues/PRs/comments](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/),
  Sept 2026), each captioned with its month and available-date count, so
  you can see the actual calendar state for every month checked, not just
  a status string:
  - **available** → opens an issue labeled `acuity-availability` with the
    screenshot attached (or comments on the existing one, so you're not
    spammed with duplicates).
  - **unavailable** → closes that issue if one was open. Quiet otherwise —
    no issue on a normal "nothing open" day.
  - **unknown** (selectors didn't match anything recognizable, or the script
    crashed) → opens/updates an issue labeled `monitor-needs-attention` with
    the screenshot attached, and fails the job so it's visible as a red X
    in the Actions tab too.
  - The workflow also installs a current `gh` CLI from `cli.github.com`'s
    apt repo before this step, since `--attach` is too new to be on
    `ubuntu-latest`'s preinstalled `gh` yet.
  - The screenshot and `result.json` are also uploaded as a workflow
    artifact on every run, regardless of status, for deeper debugging.

### Attachments need a real PAT, not the default token

`gh --attach` only accepts an OAuth token or a Personal Access Token —
`gh`'s own source (`internal/attachments/client.go`) explicitly rejects
GitHub Actions' default `GITHUB_TOKEN` (a `ghs_...` installation token)
with "unsupported authentication type". So without a PAT, issues still
get filed, but without the inline screenshot — `report-issue.sh` catches
that failure and retries without `--attach`, adding a line pointing at
the run's uploaded artifact instead, so alerting never goes silent
because of this.

This repo has a PAT with issues read/write access stored as the
`GH_TOKEN` repository secret (Settings → Secrets and variables →
Actions), and the workflow's "Report result via GitHub issue" step
reads it via `GH_TOKEN: ${{ secrets.GH_TOKEN }}`, so screenshots attach
inline.

### Getting notified

Assigning the issue alone isn't enough: GitHub never emails you about
your own actions, and since `GH_TOKEN` is a personal PAT, every
create/assign/comment made with it is authored *as you* — a
self-assignment that silently never notifies, no matter how many repos
you own or how the issue is labeled.

The fix is to do the notification-triggering actions (create, assign,
comment) as a genuinely different actor: the default `GITHUB_TOKEN`,
which authenticates as `github-actions[bot]`, not a person. That's
passed into `report-issue.sh` as `GH_BOT_TOKEN`. So:

- Creating an issue, assigning it to `lennyburdette`, and commenting on
  or closing an existing one all go through the bot token — a real
  cross-actor event, so it actually notifies.
- Attaching a screenshot still needs the PAT (`GH_TOKEN`), since
  `--attach` rejects the bot's installation token. That happens as a
  follow-up `gh issue edit --attach` right after the bot creates the
  issue — a self-authored edit generates no notification of its own, but
  the creation already did, and the screenshot ends up in the issue body
  either way. Recurring comments on an already-open issue skip the
  attachment (it would be self-authored either way) and just point at
  the run's screenshots instead.

### Verifying it actually works (first run)

Trigger the workflow manually from the Actions tab ("Run workflow"). The
`force_report` input defaults to `true` on manual runs, which files a
one-off issue (labeled `acuity-first-run`) with the screenshot attached
*even if the result is "unavailable"* — so you get a notification and can
see exactly what the script saw. Scheduled (cron) runs never set this, so
the normal quiet behavior for "unavailable" is untouched. Uncheck the box
if you want a manual run to behave like a normal scheduled one.

## Local run

```sh
npm install
npx playwright install --with-deps chromium
npm run check
cat result.json
```

`scripts/report-issue.sh` is meant to run inside GitHub Actions (it reads
`GITHUB_REPOSITORY`/`GITHUB_SERVER_URL`/`GITHUB_RUN_ID` from the runner
environment and needs `GH_TOKEN` set for `gh` auth) — it's not intended to
be run standalone locally.

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
