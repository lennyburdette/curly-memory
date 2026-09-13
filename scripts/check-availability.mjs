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
// only way to see what actually happened.

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
const SCREENSHOT_PATH = path.join(process.cwd(), "acuity-check.png");

const NO_AVAILABILITY_PATTERNS = [
  /no (available|open) (times|appointments|slots)/i,
  /nothing.{0,20}available/i,
  /no openings/i,
  /fully booked/i,
  /there are no times available/i,
  /no times? (are )?available/i,
];

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function writeResult(result) {
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  log("Wrote result.json:");
  console.log(JSON.stringify(result, null, 2));
}

async function saveScreenshot(page, label) {
  try {
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    log(`Screenshot saved (${label}) -> ${SCREENSHOT_PATH}`);
  } catch (err) {
    log(`Screenshot FAILED (${label}):`, err.message);
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

const AVAILABLE_DAY_SELECTORS = [
  "td.calendar-day:not(.unavailable):not(.disabled) a",
  'button[data-testid="calendar-day"]:not([disabled]):not([aria-disabled="true"])',
  '[class*="calendar-day"]:not([aria-disabled="true"]):not(.unavailable):not(.disabled) a',
  '[class*="calendar"] button:not([disabled]):not([aria-disabled="true"])',
];

// Matches calendar day cells regardless of availability, so we can tell
// "we found the calendar grid but every day is booked" (unavailable) apart
// from "this page doesn't look like the calendar we expect" (unknown).
const ANY_DAY_SELECTORS = ["td.calendar-day", '[class*="calendar-day"]', '[class*="calendar"] button'];

async function countAvailableDays(frame) {
  // Covers both the legacy PHP calendar markup and the newer React calendar.
  for (const sel of AVAILABLE_DAY_SELECTORS) {
    const count = await frame
      .locator(sel)
      .count()
      .catch(() => 0);
    if (count > 0) {
      log(`Available-day selector matched: "${sel}" -> ${count} day(s).`);
      return count;
    }
  }
  log("No available-day selector matched anything.");
  return 0;
}

async function hasRecognizedCalendarStructure(frame) {
  for (const sel of ANY_DAY_SELECTORS) {
    const count = await frame
      .locator(sel)
      .count()
      .catch(() => 0);
    if (count > 0) {
      log(`Calendar structure recognized via selector "${sel}" (${count} day cell(s)).`);
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
  log(`Will check up to ${MONTHS_TO_CHECK} month(s) for an open slot.`);

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

    log("Waiting 2s for the calendar to render...");
    await page.waitForTimeout(2000);

    let availableDates = 0;
    let monthsChecked = 0;
    let noAvailabilityMessageSeen = false;
    let calendarStructureSeen = false;
    let ranOutOfMonthsToAdvance = false;

    for (let i = 0; i < MONTHS_TO_CHECK; i++) {
      monthsChecked++;
      log(`--- Checking month ${monthsChecked} of up to ${MONTHS_TO_CHECK} ---`);

      if (await hasNoAvailabilityText(frame)) {
        noAvailabilityMessageSeen = true;
        break;
      }

      if (await hasRecognizedCalendarStructure(frame)) {
        calendarStructureSeen = true;
      }

      const count = await countAvailableDays(frame);
      availableDates += count;
      log(`Month ${monthsChecked}: ${count} available day(s) found (running total: ${availableDates}).`);
      if (count > 0) break;

      const advanced = await goToNextMonth(frame);
      if (!advanced) {
        ranOutOfMonthsToAdvance = true;
        break;
      }
    }

    log(
      `Loop finished. monthsChecked=${monthsChecked}, availableDates=${availableDates}, ` +
        `noAvailabilityMessageSeen=${noAvailabilityMessageSeen}, calendarStructureSeen=${calendarStructureSeen}, ` +
        `ranOutOfMonthsToAdvance=${ranOutOfMonthsToAdvance}`,
    );

    await saveScreenshot(page, "final-state");

    if (availableDates > 0) {
      log("DECISION: available");
      writeResult({
        status: "available",
        checkedAt: new Date().toISOString(),
        message: `Found ${availableDates} selectable date(s) with availability within ${monthsChecked} month(s) checked.`,
        monthsChecked,
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
      (calendarStructureSeen && (ranOutOfMonthsToAdvance || monthsChecked >= MONTHS_TO_CHECK))
    ) {
      log("DECISION: unavailable");
      writeResult({
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: `No availability found within ${monthsChecked} month(s) checked.`,
        monthsChecked,
      });
      return;
    }

    log("DECISION: unknown (calendar structure was never confidently recognized)");
    writeResult({
      status: "unknown",
      checkedAt: new Date().toISOString(),
      message:
        "Reached the calendar but could not confidently determine availability. Selectors may need updating.",
      monthsChecked,
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
