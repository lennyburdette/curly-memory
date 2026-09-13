// Checks the Acuity scheduling widget embedded at TARGET_URL for open slots
// on the "Free Get Acquainted Meeting - 30 Minute Video Meeting" appointment
// type, and writes the outcome to result.json for the workflow to act on.
//
// Acuity's widget markup has changed over the years (legacy PHP calendar vs.
// newer React calendar), so the selectors below are intentionally broad and
// layered with fallbacks. If the site changes layout, this script reports
// status "unknown" rather than guessing, so the workflow can flag it for a
// human instead of silently reporting false negatives.
//
// Logs liberally to stdout (prefixed with a timestamp) since this runs
// unattended in a scheduled GitHub Actions job — the run log is often the
// only way to see what actually happened. It also always screenshots each
// month it looks at (acuity-check-month-N.png), so a wrong "available" or
// "unavailable" call can be checked against what the page actually showed.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const TARGET_URL = "https://www.realworldfp.com/scheduleameeting";
// Acuity embeds show up under either its legacy domain or its short embed
// domain (e.g. https://realworldfp.as.me/schedule/...) depending on how the
// site owner set up the widget.
const ACUITY_FRAME_PATTERN = /acuityscheduling\.com|\.as\.me\//i;
const APPOINTMENT_NAME_PATTERN =
  /free get acquainted meeting[\s\S]{0,80}30 minute|30 minute[\s\S]{0,80}free get acquainted meeting|free get acquainted meeting/i;
const MONTHS_TO_CHECK = 3;
const RESULT_PATH = path.join(process.cwd(), "result.json");
// Used for failure screenshots taken before/outside the per-month loop
// (appointment type not found, calendar never rendered, a crash).
const FAILURE_SCREENSHOT_PATH = path.join(process.cwd(), "acuity-check.png");

const NO_AVAILABILITY_PATTERNS = [
  /no (available|open) (times|appointments|slots)/i,
  /nothing.{0,20}available/i,
  /no openings/i,
  /fully booked/i,
  /there are no times available/i,
  /no times? (are )?available/i,
];

// A calendar day control almost always shows just the day-of-month as its
// entire visible text (e.g. "14"), which reliably distinguishes it from
// navigation/today/month-year controls that use icons or words. Those
// controls sometimes still end up matched by a broad "any button inside a
// calendar-ish container" selector, so also exclude anything whose
// aria-label looks like navigation chrome rather than a date.
const DAY_CELL_CANDIDATE_SELECTOR = '[class*="calendar"] button, [class*="calendar"] a, [class*="calendar-day"]';
const BARE_DAY_NUMBER_PATTERN = /^\s*\d{1,2}\s*$/;
const NAV_LABEL_EXCLUDE_PATTERN = /previous|next|today|month|year|close|back|forward|week/i;
const MONTH_YEAR_PATTERN =
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function writeResult(result) {
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  log("Wrote result.json:");
  console.log(JSON.stringify(result, null, 2));
}

async function saveScreenshot(page, label, filePath = FAILURE_SCREENSHOT_PATH) {
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    log(`Screenshot saved (${label}) -> ${filePath}`);
    return true;
  } catch (err) {
    log(`Screenshot FAILED (${label}):`, err.message);
    return false;
  }
}

async function findAcuityFrame(page) {
  // The widget is often injected asynchronously by embed.js into an iframe,
  // so poll for it rather than assuming it exists at load.
  log("Looking for an Acuity iframe (polling up to 30s)...");
  const deadline = Date.now() + 30_000;
  let lastFrameCount = -1;
  while (Date.now() < deadline) {
    const frames = page.frames();
    if (frames.length !== lastFrameCount) {
      log(
        `Frames on page (${frames.length}):`,
        frames.map((f) => f.url() || "(about:blank)"),
      );
      lastFrameCount = frames.length;
    }
    for (const frame of frames) {
      if (ACUITY_FRAME_PATTERN.test(frame.url())) {
        log("Found Acuity iframe:", frame.url());
        return frame;
      }
    }
    await page.waitForTimeout(1000);
  }
  log("No Acuity iframe found after 30s — falling back to the main frame.");
  return null;
}

async function dismissCookieBanner(page) {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'button:has-text("Allow")',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        log(`Dismissing cookie/consent banner via selector: ${sel}`);
        await btn.click({ timeout: 2000 });
      }
    } catch {
      // Banner not present with this selector — that's fine.
    }
  }
}

async function selectAppointmentType(frame) {
  // If the embed URL already pins a single appointment type, the calendar
  // may be showing already with nothing to select.
  log("Checking whether the calendar is already showing (single-type embed)...");
  const alreadyOnCalendar = await frame
    .getByText(/select a date|select date & time/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (alreadyOnCalendar) {
    log("Calendar already visible — no appointment type to select.");
    return true;
  }

  log(`Looking for the "Free Get Acquainted Meeting" appointment type link/button...`);

  // The current Acuity widget renders each appointment type as a list item
  // (class containing "select-item") where the name text and the "Book"
  // button are siblings, not the same clickable element — clicking the name
  // itself is a real click that "succeeds" but does nothing. Scope to the
  // matching item and click its Book button specifically.
  const item = frame.locator('[class*="select-item"]').filter({ hasText: APPOINTMENT_NAME_PATTERN }).first();
  const itemCount = await item.count().catch(() => 0);
  log(`Strategy "select-item + Book button": ${itemCount} matching item(s).`);
  if (itemCount) {
    const bookButton = item.getByRole("button", { name: /book/i }).first();
    const bookCount = await bookButton.count().catch(() => 0);
    log(`"Book" button within matched item: ${bookCount} match(es).`);
    if (bookCount) {
      try {
        await bookButton.scrollIntoViewIfNeeded();
        await bookButton.click({ timeout: 5000 });
        log('Clicked the "Book" button for the matched appointment type.');
        return true;
      } catch (err) {
        log(`Clicking the "Book" button failed: ${err.message}`);
      }
    }
  }

  log("Falling back to older/generic strategies...");
  const strategies = [
    { name: "role=link", locator: () => frame.getByRole("link", { name: APPOINTMENT_NAME_PATTERN }) },
    { name: "role=button", locator: () => frame.getByRole("button", { name: APPOINTMENT_NAME_PATTERN }) },
    { name: "text match", locator: () => frame.getByText(APPOINTMENT_NAME_PATTERN) },
  ];

  for (const strategy of strategies) {
    const locator = strategy.locator().first();
    const count = await locator.count().catch(() => 0);
    log(`Strategy "${strategy.name}": ${count} match(es).`);
    if (!count) continue;

    try {
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 5000 });
      log(`Clicked appointment type via strategy "${strategy.name}".`);
      return true;
    } catch (err) {
      log(`Direct click failed for strategy "${strategy.name}" (${err.message}); trying nearest clickable ancestor.`);
      // The matched text node itself might not be clickable — try the
      // nearest clickable ancestor (an <a>, <button>, or role="button").
      try {
        const ancestor = locator.locator(
          'xpath=ancestor-or-self::*[self::a or self::button or @role="button"][1]',
        );
        await ancestor.first().click({ timeout: 5000 });
        log(`Clicked appointment type via ancestor of strategy "${strategy.name}".`);
        return true;
      } catch (ancestorErr) {
        log(`Ancestor click also failed for strategy "${strategy.name}": ${ancestorErr.message}`);
        continue;
      }
    }
  }
  log("Could not click the appointment type via any strategy.");
  return false;
}

async function hasNoAvailabilityText(frame) {
  const bodyText = await frame
    .locator("body")
    .innerText()
    .catch(() => "");
  const matched = NO_AVAILABILITY_PATTERNS.find((re) => re.test(bodyText));
  if (matched) {
    log(`Found explicit "no availability" text matching ${matched}.`);
    return true;
  }
  return false;
}

async function getVisibleMonthLabel(frame) {
  try {
    const text = await frame.locator("body").innerText();
    const match = text.match(MONTH_YEAR_PATTERN);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// Older, broader fallback selectors for widgets that don't render a bare
// day-of-month number as the cell's visible text (e.g. legacy Acuity skins).
const AVAILABLE_DAY_FALLBACK_SELECTORS = [
  "td.calendar-day:not(.unavailable):not(.disabled) a",
  'button[data-testid="calendar-day"]:not([disabled]):not([aria-disabled="true"])',
  '[class*="calendar-day"]:not([aria-disabled="true"]):not(.unavailable):not(.disabled) a',
];
const ANY_DAY_FALLBACK_SELECTORS = ["td.calendar-day", '[class*="calendar-day"]'];

// Classifies every "day-shaped" candidate in the calendar (bare 1-2 digit
// visible text, inside a calendar-ish container) as available or not, and
// logs a handful of samples either way so a wrong verdict can be diagnosed
// straight from the run log — no screenshot access required.
async function inspectDayCells(frame) {
  const candidates = frame.locator(DAY_CELL_CANDIDATE_SELECTOR).filter({ hasText: BARE_DAY_NUMBER_PATTERN });
  const total = await candidates.count().catch(() => 0);

  if (total === 0) {
    return { total: 0, available: 0, samples: [] };
  }

  let available = 0;
  const samples = [];
  for (let i = 0; i < total; i++) {
    const el = candidates.nth(i);
    const [disabled, ariaDisabled, ariaLabel, text, className] = await Promise.all([
      el.getAttribute("disabled").catch(() => null),
      el.getAttribute("aria-disabled").catch(() => null),
      el.getAttribute("aria-label").catch(() => null),
      el.innerText().catch(() => ""),
      el.getAttribute("class").catch(() => null),
    ]);
    const isNav = ariaLabel ? NAV_LABEL_EXCLUDE_PATTERN.test(ariaLabel) : false;
    const isDisabled = disabled !== null || ariaDisabled === "true";
    const isAvailable = !isNav && !isDisabled;
    if (isAvailable) available++;
    if (samples.length < 15) {
      samples.push({
        text: text.trim(),
        ariaLabel,
        className,
        disabled: disabled !== null,
        ariaDisabled: ariaDisabled === "true",
        excludedAsNav: isNav,
        countedAsAvailable: isAvailable,
      });
    }
  }
  return { total, available, samples };
}

async function countAvailableDays(frame) {
  const { total, available, samples } = await inspectDayCells(frame);
  if (total > 0) {
    log(`Day-number heuristic: ${total} day cell(s) found, ${available} counted as available.`);
    log("Day cell samples:", JSON.stringify(samples));
    return available;
  }

  log("Day-number heuristic found nothing — trying older fallback selectors.");
  for (const sel of AVAILABLE_DAY_FALLBACK_SELECTORS) {
    const count = await frame
      .locator(sel)
      .count()
      .catch(() => 0);
    if (count > 0) {
      log(`Fallback available-day selector matched: "${sel}" -> ${count} day(s).`);
      return count;
    }
  }
  log("No available-day selector matched anything.");
  return 0;
}

async function dumpFrameSnapshot(frame, label) {
  try {
    const html = await frame.locator("body").innerHTML();
    const MAX = 6000;
    const snippet = html.length > MAX ? `${html.slice(0, MAX)}... [truncated, ${html.length} total chars]` : html;
    log(`--- Frame body HTML snapshot (${label}) ---`);
    log(snippet);
    log("--- end snapshot ---");
  } catch (err) {
    log(`Could not capture frame HTML snapshot (${label}):`, err.message);
  }
}

async function hasRecognizedCalendarStructure(frame) {
  const { total } = await inspectDayCells(frame);
  if (total > 0) {
    log(`Calendar structure recognized via day-number heuristic (${total} day cell(s)).`);
    return true;
  }
  for (const sel of ANY_DAY_FALLBACK_SELECTORS) {
    const count = await frame
      .locator(sel)
      .count()
      .catch(() => 0);
    if (count > 0) {
      log(`Calendar structure recognized via fallback selector "${sel}" (${count} day cell(s)).`);
      return true;
    }
  }
  log("Calendar structure NOT recognized by any selector.");
  return false;
}

async function goToNextMonth(frame) {
  const nextSelectors = [
    'button[aria-label*="Next" i]',
    'a[aria-label*="Next" i]',
    ".next-month",
    'button:has-text(">")',
  ];
  for (const sel of nextSelectors) {
    const btn = frame.locator(sel).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;

    const disabled = await btn.getAttribute("disabled").catch(() => null);
    const ariaDisabled = await btn.getAttribute("aria-disabled").catch(() => null);
    if (disabled !== null || ariaDisabled === "true") {
      log(`Next-month control found via "${sel}" but it's disabled — no more months to check.`);
      return false;
    }

    log(`Clicking next-month control via selector "${sel}".`);
    await btn.click({ timeout: 5000 }).catch((err) => log(`Next-month click failed: ${err.message}`));
    await frame.page().waitForTimeout(1500);
    return true;
  }
  log("No next-month control found.");
  return false;
}

async function main() {
  log(`Starting availability check for: ${TARGET_URL}`);
  log(`Will check ${MONTHS_TO_CHECK} month(s), screenshotting each one.`);

  const browser = await chromium.launch({ headless: true });
  log(`Chromium launched (version ${browser.version()}).`);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.on("console", (msg) => log(`[browser:${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => log("[browser:pageerror]", err.message));
  page.on("requestfailed", (req) =>
    log(`[browser:requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`),
  );

  try {
    log(`Navigating to ${TARGET_URL} ...`);
    const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    log(`Navigation finished. HTTP status: ${response?.status()}`);

    await dismissCookieBanner(page);

    const frame = (await findAcuityFrame(page)) ?? page.mainFrame();
    log(`Using frame: ${frame.url() || "(main frame)"}`);
    await frame.waitForLoadState("domcontentloaded").catch((err) => log("waitForLoadState error:", err.message));

    const selected = await selectAppointmentType(frame);
    if (!selected) {
      await saveScreenshot(page, "appointment-type-not-found");
      writeResult({
        status: "unknown",
        checkedAt: new Date().toISOString(),
        message:
          'Could not find or click the "Free Get Acquainted Meeting" appointment type. The page layout may have changed.',
      });
      return;
    }

    log("Waiting for the calendar to render (polling up to 10s)...");
    let renderedInTime = await hasRecognizedCalendarStructure(frame);
    const renderDeadline = Date.now() + 10_000;
    while (!renderedInTime && Date.now() < renderDeadline) {
      await page.waitForTimeout(1000);
      renderedInTime = await hasRecognizedCalendarStructure(frame);
    }
    log(`Calendar structure recognized before the loop starts: ${renderedInTime}`);
    if (!renderedInTime) {
      await dumpFrameSnapshot(frame, "calendar-not-recognized-after-wait");
    }

    const months = [];
    let totalAvailable = 0;
    let noAvailabilityMessageSeen = false;
    let calendarStructureSeen = false;
    let ranOutOfMonthsToAdvance = false;

    for (let i = 0; i < MONTHS_TO_CHECK; i++) {
      const monthIndex = i + 1;
      log(`--- Checking month ${monthIndex} of ${MONTHS_TO_CHECK} ---`);

      const label = await getVisibleMonthLabel(frame);
      log(`Visible month label: ${label ?? "(not found)"}`);

      const noAvailText = await hasNoAvailabilityText(frame);
      if (noAvailText) noAvailabilityMessageSeen = true;

      const structureRecognized = await hasRecognizedCalendarStructure(frame);
      if (structureRecognized) calendarStructureSeen = true;

      const available = noAvailText ? 0 : await countAvailableDays(frame);
      totalAvailable += available;
      log(`Month ${monthIndex} (${label ?? "unknown"}): ${available} available day(s).`);

      const screenshotPath = path.join(process.cwd(), `acuity-check-month-${monthIndex}.png`);
      const screenshotSaved = await saveScreenshot(page, `month-${monthIndex}`, screenshotPath);

      months.push({
        index: monthIndex,
        label,
        availableDates: available,
        calendarStructureRecognized: structureRecognized,
        noAvailabilityMessageSeen: noAvailText,
        screenshot: screenshotSaved ? path.basename(screenshotPath) : null,
      });

      if (noAvailText) {
        log('No-availability text found — stopping early, later months would show the same message.');
        break;
      }

      if (i < MONTHS_TO_CHECK - 1) {
        const advanced = await goToNextMonth(frame);
        if (!advanced) {
          ranOutOfMonthsToAdvance = true;
          break;
        }
      }
    }

    log(
      `Loop finished. monthsChecked=${months.length}, totalAvailable=${totalAvailable}, ` +
        `noAvailabilityMessageSeen=${noAvailabilityMessageSeen}, calendarStructureSeen=${calendarStructureSeen}, ` +
        `ranOutOfMonthsToAdvance=${ranOutOfMonthsToAdvance}`,
    );

    const perMonthSummary = months
      .map((m) => `${m.label ?? `month ${m.index}`}: ${m.availableDates} available date(s)`)
      .join("; ");

    if (totalAvailable > 0) {
      log("DECISION: available");
      writeResult({
        status: "available",
        checkedAt: new Date().toISOString(),
        message: `Found ${totalAvailable} selectable date(s) across ${months.length} month(s) checked. ${perMonthSummary}`,
        monthsChecked: months.length,
        months,
      });
      return;
    }

    // "Unavailable" requires either an explicit no-availability message, or
    // having recognized the calendar grid itself (so we trust the zero
    // count) with nowhere further to page to. If we never recognized the
    // calendar structure at all, we can't trust a zero count — that's
    // reported as "unknown" below instead, so selector drift surfaces as a
    // flag for a human rather than a silent false "unavailable".
    if (
      noAvailabilityMessageSeen ||
      (calendarStructureSeen && (ranOutOfMonthsToAdvance || months.length >= MONTHS_TO_CHECK))
    ) {
      log("DECISION: unavailable");
      writeResult({
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: `No availability found across ${months.length} month(s) checked. ${perMonthSummary}`,
        monthsChecked: months.length,
        months,
      });
      return;
    }

    log("DECISION: unknown (calendar structure was never confidently recognized)");
    writeResult({
      status: "unknown",
      checkedAt: new Date().toISOString(),
      message:
        "Reached the calendar but could not confidently determine availability. Selectors may need updating.",
      monthsChecked: months.length,
      months,
    });
  } catch (err) {
    log("ERROR during check:", err.stack || err.message);
    await saveScreenshot(page, "error");
    writeResult({
      status: "unknown",
      checkedAt: new Date().toISOString(),
      message: `Error while checking availability: ${err.message}`,
    });
    process.exitCode = 1;
  } finally {
    await browser.close();
    log("Browser closed. Done.");
  }
}

main();
