#!/usr/bin/env bash
# Reports the outcome of scripts/check-availability.mjs (result.json plus
# one acuity-check-month-N.png screenshot per month it looked at) to GitHub
# Issues, attaching every screenshot via the gh CLI's --attach flag:
# https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/
#
# Two tokens, two jobs — this matters for notifications, not just auth:
#
# 1. GH_TOKEN: a personal PAT (repo secret). Required for --attach, since
#    gh's internal/attachments/client.go only allow-lists OAuth and PAT
#    tokens — the default GITHUB_TOKEN (a ghs_... installation token) is
#    explicitly rejected with "unsupported authentication type".
# 2. GH_BOT_TOKEN: the default GITHUB_TOKEN, authenticating as the
#    github-actions[bot] app rather than a person. This matters because
#    GitHub never emails you about your own actions — if GH_TOKEN belongs
#    to the same person this script assigns/creates issues for, every
#    create/assign/comment is a self-action and silently never notifies,
#    no matter how the issue ends up labeled or assigned. Since the bot is
#    a genuinely different actor, the SAME assignment done via GH_BOT_TOKEN
#    is a normal cross-actor event and does notify.
#
# So: creating, assigning, and commenting (the notification-triggering
# actions) go through the bot token; only attaching a screenshot — which
# requires the PAT — happens via GH_TOKEN, as a follow-up edit after the
# bot has already created the issue and fired the notification.
#
# Expects to run inside GitHub Actions: GITHUB_REPOSITORY, GITHUB_SERVER_URL,
# and GITHUB_RUN_ID are provided by the runner. GH_TOKEN and GH_BOT_TOKEN
# must both be set. FORCE_REPORT=true additionally files a one-off
# verification issue for statuses that would otherwise stay quiet
# (unavailable) — useful for confirming the checker works end to end.

set -euo pipefail

REPO="$GITHUB_REPOSITORY"
RUN_URL="${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}"
FORCE_REPORT="${FORCE_REPORT:-false}"
ASSIGNEE="lennyburdette"
GH_BOT_TOKEN="${GH_BOT_TOKEN:-}"

echo "== report-issue.sh starting =="
echo "Repo: $REPO"
echo "Run URL: $RUN_URL"
echo "Force report: $FORCE_REPORT"
echo "Bot token available: $([ -n "$GH_BOT_TOKEN" ] && echo yes || echo no)"
gh --version

bot_gh() {
  if [ -z "$GH_BOT_TOKEN" ]; then
    echo "GH_BOT_TOKEN not set — falling back to GH_TOKEN (won't notify if it's a self-authored PAT)." >&2
    gh "$@"
  else
    GH_TOKEN="$GH_BOT_TOKEN" gh "$@"
  fi
}

if [ -f result.json ]; then
  echo "Reading result.json:"
  cat result.json
  STATUS=$(jq -r '.status' result.json)
  MESSAGE=$(jq -r '.message // ""' result.json)
  CHECKED_AT=$(jq -r '.checkedAt // ""' result.json)
else
  echo "result.json not found — the check script must have crashed before writing it."
  STATUS="unknown"
  MESSAGE="The check script crashed before writing a result. See the run log: ${RUN_URL}"
  CHECKED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
fi

echo "Status: $STATUS"
echo "Message: $MESSAGE"
echo "Checked at: $CHECKED_AT"

ATTACH_ARGS=()
HAS_SCREENSHOT=false

if [ -f result.json ] && jq -e '(.months // []) | length > 0' result.json >/dev/null 2>&1; then
  echo "Building attachments from per-month screenshots..."
  while IFS=$'\t' read -r file label available; do
    if [ -n "$file" ] && [ -f "$file" ]; then
      HAS_SCREENSHOT=true
      caption="${label:-Month}: ${available} available date(s)"
      ATTACH_ARGS+=(--attach "${file}#${caption}")
      echo "  will attach: $file (\"$caption\")"
    else
      echo "  skipping missing screenshot: ${file:-<none>}"
    fi
  done < <(jq -r '.months[] | [(.screenshot // ""), (.label // ("Month " + (.index|tostring))), (.availableDates|tostring)] | @tsv' result.json)
elif [ -f acuity-check.png ]; then
  # Failure-path screenshot (appointment type not found, calendar never
  # rendered, a crash) — single file, no per-month breakdown available.
  HAS_SCREENSHOT=true
  ATTACH_ARGS=(--attach "acuity-check.png#Acuity widget screenshot - $STATUS as of $CHECKED_AT")
  echo "Screenshot found (acuity-check.png) — will attach to any issue/comment."
else
  echo "No screenshot found — issues will be filed without one."
fi

ensure_label() {
  echo "Ensuring label exists: $1"
  bot_gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null
}

ensure_label acuity-availability 0E8A16 "Acuity has an open slot for the meeting"
ensure_label monitor-needs-attention D93F0B "The availability checker could not read the calendar"
ensure_label acuity-first-run 5319E7 "Manual verification run report"

find_open_issue() {
  bot_gh issue list --repo "$REPO" --state open --label "$1" --json number --jq '.[0].number // empty'
}

# Creates the issue via the bot token — a genuine cross-actor event, so
# assigning the user actually notifies them — then attaches screenshots
# via the PAT in a follow-up edit (--attach requires PAT/OAuth). The edit
# itself won't generate its own notification, but the creation already did,
# and the screenshot lands in the issue body either way.
#
# Also puts an explicit @mention in the bot-authored body as a second,
# independent trigger: GitHub's "assigned" sub-event has turned out to
# record the assignee as its actor even when the surrounding gh issue
# create call (and its "labeled" sub-event) is unambiguously bot-authored
# — an edge case around assigning at creation time, not something a plain
# text mention is subject to.
gh_create_issue() {
  local title="$1" label="$2" body="$3"
  local out number

  body="@$ASSIGNEE

$body"
  out=$(bot_gh issue create --repo "$REPO" --title "$title" --label "$label" --assignee "$ASSIGNEE" --body "$body")
  echo "$out"
  number=$(echo "$out" | grep -oE '/issues/[0-9]+' | tail -1 | grep -oE '[0-9]+')

  if [ -z "$number" ]; then
    echo "Could not parse the issue number from gh's output — skipping attachment."
    return 0
  fi
  if [ "$HAS_SCREENSHOT" != "true" ]; then
    return 0
  fi

  echo "Attaching screenshot(s) to #$number via the PAT..."
  if ! gh issue edit "$number" --repo "$REPO" "${ATTACH_ARGS[@]}" 2>&1; then
    echo "Attaching screenshot(s) failed — see this run's uploaded artifact instead: $RUN_URL"
  fi
}

# Backfills the assignee on an issue that predates this being wired in, so
# older still-open issues start notifying too, not just newly created ones.
# Via the bot token, since a self-authored assignment never notifies.
ensure_assignee() {
  local number="$1"
  bot_gh issue edit "$number" --repo "$REPO" --add-assignee "$ASSIGNEE" >/dev/null 2>&1 || true
}

# Comments on an existing issue via the bot token, so it actually notifies.
# No attachment here (that would need the PAT, i.e. a self-authored second
# comment, which wouldn't notify anyway) — the original screenshot(s) stay
# on the issue from its creation; this points at the fresh run instead.
gh_comment_issue() {
  local number="$1" body="$2"
  ensure_assignee "$number"
  body="@$ASSIGNEE

$body"
  if [ "$HAS_SCREENSHOT" = "true" ]; then
    body="$body

(Screenshots from this run: $RUN_URL)"
  fi
  bot_gh issue comment "$number" --repo "$REPO" --body "$body"
}

close_if_open() {
  local label="$1"
  local comment="$2"
  local issue
  issue=$(find_open_issue "$label")
  if [ -n "$issue" ]; then
    echo "Closing open issue #$issue (label: $label)"
    ensure_assignee "$issue"
    bot_gh issue comment "$issue" --repo "$REPO" --body "$comment"
    bot_gh issue close "$issue" --repo "$REPO"
  else
    echo "No open issue with label $label to close."
  fi
}

case "$STATUS" in
  available)
    BODY=$(cat <<EOF
Availability detected for **Free Get Acquainted Meeting - 30 Minute Video Meeting**.

$MESSAGE

Book here: https://www.realworldfp.com/scheduleameeting

Checked at: $CHECKED_AT
Run: $RUN_URL
EOF
)
    ISSUE=$(find_open_issue acuity-availability)
    if [ -z "$ISSUE" ]; then
      echo "No open acuity-availability issue — creating one."
      gh_create_issue "Acuity availability found: Free Get Acquainted Meeting" acuity-availability "$BODY"
    else
      echo "Open acuity-availability issue #$ISSUE already exists — commenting instead."
      gh_comment_issue "$ISSUE" "$BODY"
    fi
    close_if_open monitor-needs-attention "Check succeeded again — closing."
    ;;

  unavailable)
    close_if_open acuity-availability "No longer available as of $CHECKED_AT."
    close_if_open monitor-needs-attention "Check succeeded again — closing."
    ;;

  *)
    BODY=$(cat <<EOF
The availability checker could not confidently determine the calendar state.

$MESSAGE

Run: $RUN_URL
EOF
)
    ISSUE=$(find_open_issue monitor-needs-attention)
    if [ -z "$ISSUE" ]; then
      echo "No open monitor-needs-attention issue — creating one."
      gh_create_issue "Acuity availability monitor needs attention" monitor-needs-attention "$BODY"
    else
      echo "Open monitor-needs-attention issue #$ISSUE already exists — commenting instead."
      gh_comment_issue "$ISSUE" "$BODY"
    fi
    ;;
esac

if [ "$FORCE_REPORT" = "true" ] && [ "$STATUS" != "available" ]; then
  echo "force_report is set — filing a verification issue regardless of status."
  BODY=$(cat <<EOF
Manual verification run (force_report was set).

Status: **$STATUS**

$MESSAGE

Checked at: $CHECKED_AT
Run: $RUN_URL
EOF
)
  gh_create_issue "Acuity availability check - verification run ($STATUS)" acuity-first-run "$BODY"
fi

echo "== report-issue.sh done =="
