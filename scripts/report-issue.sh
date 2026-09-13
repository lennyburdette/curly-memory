#!/usr/bin/env bash
# Reports the outcome of scripts/check-availability.mjs (result.json plus
# one acuity-check-month-N.png screenshot per month it looked at) to GitHub
# Issues, attaching every screenshot via the gh CLI's --attach flag:
# https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/
#
# NOTE: --attach only works with an OAuth token or a Personal Access Token
# (gh's internal/attachments/client.go allow-lists TokenTypeOAuth and
# TokenTypePersonalAccess). The default GITHUB_TOKEN GitHub Actions injects
# is a GitHub App installation token and is explicitly rejected ("unsupported
# authentication type"). If GH_TOKEN is the default Actions token, every
# --attach call below will fail — this script catches that and falls back to
# filing the issue without the attachment, linking to the workflow's
# artifact instead, so alerting doesn't go silent. To get real inline
# screenshots, set GH_TOKEN (in the workflow) to a repo secret holding a
# classic or fine-grained PAT with issue read/write access.
#
# Expects to run inside GitHub Actions: GITHUB_REPOSITORY, GITHUB_SERVER_URL,
# and GITHUB_RUN_ID are provided by the runner, and GH_TOKEN must be set for
# gh CLI auth. FORCE_REPORT=true additionally files a one-off verification
# issue for statuses that would otherwise stay quiet (unavailable) — useful
# for confirming the checker works end to end on its first run.

set -euo pipefail

REPO="$GITHUB_REPOSITORY"
RUN_URL="${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}"
FORCE_REPORT="${FORCE_REPORT:-false}"
# GitHub only emails you for a thread you're subscribed to — being @mentioned,
# assigned, or having commented/opened it yourself. A bot-created issue
# doesn't auto-subscribe the repo owner, so assign every new issue to them;
# GitHub always notifies assignees regardless of watch settings.
ASSIGNEE="lennyburdette"

echo "== report-issue.sh starting =="
echo "Repo: $REPO"
echo "Run URL: $RUN_URL"
echo "Force report: $FORCE_REPORT"
gh --version

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
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null
}

ensure_label acuity-availability 0E8A16 "Acuity has an open slot for the meeting"
ensure_label monitor-needs-attention D93F0B "The availability checker could not read the calendar"
ensure_label acuity-first-run 5319E7 "Manual verification run report"

find_open_issue() {
  gh issue list --repo "$REPO" --state open --label "$1" --json number --jq '.[0].number // empty'
}

# Creates an issue with the screenshot attached; if the attach upload is
# rejected (e.g. the default Actions token can't use it), retries without
# it so the alert still goes out, just without an inline image.
gh_create_issue() {
  local title="$1" label="$2" body="$3"
  local err
  if [ "$HAS_SCREENSHOT" = "true" ]; then
    if err=$(gh issue create --repo "$REPO" --title "$title" --label "$label" --assignee "$ASSIGNEE" --body "$body" "${ATTACH_ARGS[@]}" 2>&1); then
      echo "$err"
      return 0
    fi
    echo "gh issue create with --attach failed, retrying without it:"
    echo "$err"
    body="$body

(Could not attach the screenshot(s) — see this run's uploaded artifact instead: $RUN_URL)"
  fi
  gh issue create --repo "$REPO" --title "$title" --label "$label" --assignee "$ASSIGNEE" --body "$body"
}

# Backfills the assignee on an issue that predates this being wired in, so
# older still-open issues start notifying too, not just newly created ones.
ensure_assignee() {
  local number="$1"
  gh issue edit "$number" --repo "$REPO" --add-assignee "$ASSIGNEE" >/dev/null 2>&1 || true
}

# Same fallback behavior as gh_create_issue, but comments on an existing issue.
gh_comment_issue() {
  local number="$1" body="$2"
  local err
  ensure_assignee "$number"
  if [ "$HAS_SCREENSHOT" = "true" ]; then
    if err=$(gh issue comment "$number" --repo "$REPO" --body "$body" "${ATTACH_ARGS[@]}" 2>&1); then
      echo "$err"
      return 0
    fi
    echo "gh issue comment with --attach failed, retrying without it:"
    echo "$err"
    body="$body

(Could not attach the screenshot(s) — see this run's uploaded artifact instead: $RUN_URL)"
  fi
  gh issue comment "$number" --repo "$REPO" --body "$body"
}

close_if_open() {
  local label="$1"
  local comment="$2"
  local issue
  issue=$(find_open_issue "$label")
  if [ -n "$issue" ]; then
    echo "Closing open issue #$issue (label: $label)"
    ensure_assignee "$issue"
    gh issue comment "$issue" --repo "$REPO" --body "$comment"
    gh issue close "$issue" --repo "$REPO"
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
