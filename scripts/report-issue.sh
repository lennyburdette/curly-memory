#!/usr/bin/env bash
# Reports the outcome of scripts/check-availability.mjs (result.json +
# acuity-check.png) to GitHub Issues, attaching the screenshot via the gh
# CLI's --attach flag:
# https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/
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
if [ -f acuity-check.png ]; then
  ATTACH_ARGS=(--attach "acuity-check.png#Acuity calendar screenshot - $STATUS as of $CHECKED_AT")
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

close_if_open() {
  local label="$1"
  local comment="$2"
  local issue
  issue=$(find_open_issue "$label")
  if [ -n "$issue" ]; then
    echo "Closing open issue #$issue (label: $label)"
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
      gh issue create --repo "$REPO" \
        --title "Acuity availability found: Free Get Acquainted Meeting" \
        --label acuity-availability \
        --body "$BODY" \
        "${ATTACH_ARGS[@]}"
    else
      echo "Open acuity-availability issue #$ISSUE already exists — commenting instead."
      gh issue comment "$ISSUE" --repo "$REPO" --body "$BODY" "${ATTACH_ARGS[@]}"
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
      gh issue create --repo "$REPO" \
        --title "Acuity availability monitor needs attention" \
        --label monitor-needs-attention \
        --body "$BODY" \
        "${ATTACH_ARGS[@]}"
    else
      echo "Open monitor-needs-attention issue #$ISSUE already exists — commenting instead."
      gh issue comment "$ISSUE" --repo "$REPO" --body "$BODY" "${ATTACH_ARGS[@]}"
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
  gh issue create --repo "$REPO" \
    --title "Acuity availability check - verification run ($STATUS)" \
    --label acuity-first-run \
    --body "$BODY" \
    "${ATTACH_ARGS[@]}"
fi

echo "== report-issue.sh done =="
