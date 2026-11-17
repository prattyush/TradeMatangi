import { test, expect } from "@playwright/test";

// Strategy Practice (Phase 26, S15) inside the website's Pattern Library page, on both Analysis & Patterns chart renderers.
for (const renderer of ["lightweight", "kline"] as const) {
  const open = (page: any, query = "") => page.goto(`/tests/phase22/deep-dive.html?renderer=${renderer}&practice=1${query}`, { waitUntil: "domcontentloaded" });
  const watch = (page: any) => {
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return errors;
  };

  test(`Practice on the website (${renderer}): choose, filter, start, history and review`, async ({ page }) => {
    const errors = watch(page);
    await open(page);
    await page.getByRole("button", { name: /Practice/ }).click();

    // The strategies with Entry-marked days; nothing starts until one is chosen.
    await expect(page.getByRole("heading", { name: /Strategy \(1\)/ })).toBeVisible();
    await expect(page.locator(".pr-strategies li")).toContainText("3 days");
    await expect(page.getByText("Choose a strategy to practise.")).toBeVisible();
    await page.locator(".pr-strategies li button").click();
    const start = page.getByRole("button", { name: "Start practice" });
    await expect(start).toBeEnabled();
    await expect(page.getByText("About 3 days on offer")).toBeVisible();

    // Narrowing the choice changes what is on offer; nothing ticked or no match disables Start.
    await page.getByLabel("Symbol").selectOption("BSESEN");
    await expect(page.getByText("About 1 day on offer")).toBeVisible();
    await page.getByLabel("Symbol").selectOption("");
    const grade = (name: string) => page.locator(".pr-grades label").filter({ hasText: name }).locator("input");
    for (const name of ["Ideal", "Average", "Poor", "Success (not graded)", "Failed", "No outcome"]) await grade(name).uncheck();
    await expect(start).toBeDisabled(); // no grade ticked: nothing to pick from
    await grade("Ideal").check();
    await expect(page.getByText("About 1 day on offer")).toBeVisible();
    await grade("Ideal").uncheck();
    await grade("Poor").check();
    await expect(page.getByText("No day matches these choices.")).toBeVisible(); // no poor days
    await expect(start).toBeDisabled();
    await grade("Poor").uncheck();
    for (const name of ["Ideal", "Average", "Poor", "Success (not graded)", "Failed", "No outcome"]) await grade(name).check();

    // Start: the pick is asked for with the symbol and grades only when they narrow it, the speed is the host's own, and the host starts it.
    await page.getByLabel("Replay speed").fill("0.5");
    await start.click();
    await expect.poll(() => page.evaluate(() => (window as any).practiceStarts.length)).toBe(1);
    const started = await page.evaluate(() => (window as any).practiceStarts[0]);
    expect(started.speed).toBe(0.5);
    expect(started.plan.start_time).toBe("09:33:00");
    expect(started.plan.practice).toEqual({ category: "Breakout", strategy: "Opening range", start_offset_min: 12 });
    expect("side" in started.plan || "annotations" in started.plan).toBe(false); // the answer is never part of the plan
    expect(await page.evaluate(() => (window as any).practicePicks)).toEqual([{ category: "Breakout", strategy: "Opening range" }]);

    // History: a run still going cannot be reviewed; an ended one can.
    await page.getByRole("tab", { name: "History" }).click();
    const rows = page.locator(".pr-history tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("In progress");
    await expect(rows.nth(0).getByRole("button", { name: "Review" })).toBeDisabled();
    await expect(rows.nth(1)).toContainText("6 min late · kept 50%");
    await rows.nth(1).getByRole("button", { name: "Review" }).click();

    // The review: what was recorded, what it would have made, your trade against it, and two charts side by side.
    await expect(page.getByText("12 min before the first recorded entry")).toBeVisible();
    await expect(page.locator(".pr-recorded")).toContainText("Buy setup");
    await expect(page.locator(".pr-recorded")).toContainText("Ideal");
    await expect(page.locator(".pr-recorded")).toContainText("entry 09:45");
    await expect(page.locator(".pr-recorded")).toContainText("exit 10:30");
    const theory = page.locator(".pr-table").first().locator("tbody tr");
    await expect(theory.nth(0)).toContainText("09:45 @ 100");
    await expect(theory.nth(0)).toContainText("+12.00 pts (+12.00%)");
    await expect(theory.nth(1)).toContainText("No price data for this instrument on that day");
    const mine = page.locator(".pr-table").nth(1).locator("tbody tr");
    await expect(mine).toHaveCount(1);
    await expect(mine.first()).toContainText("Bought CE 24500");
    await expect(mine.first()).toContainText("Entered 6 min late");
    await expect(mine.first()).toContainText("Exited 6 min early");
    await expect(mine.first()).toContainText("You kept 50% of the +40.00 pts on offer.");
    await expect(mine.first()).toContainText("On offer at your size: 3000.00");
    await expect(page.locator(".td-chartbox")).toHaveCount(2);
    await page.locator(".td-chartbox canvas").first().waitFor();
    await expect(page.locator(".td-chartbox").nth(1)).toContainText("NIFTY CE 24500");
    await expect(page.locator(".td-legend")).toContainText("gold = your orders");
    // A trade that went the other way from what was recorded has nothing to compare with, and is listed apart.
    await expect(page.getByRole("heading", { name: "Trades that matched no recorded setup" })).toBeVisible();
    // The day's other recorded side: a failed Sell setup with no marks and no trade.
    await page.getByRole("tab", { name: "Sell setup" }).click();
    await expect(page.locator(".pr-recorded")).toContainText("Failed");
    await expect(page.getByText("Needs both an Entry and an Exit mark")).toBeVisible();
    await expect(page.getByText("You placed no Sell-side trade on this day.")).toBeVisible();
    // Maximize works like on the other screens.
    await page.getByRole("tab", { name: "Buy setup" }).click();
    await page.getByRole("button", { name: /Maximize NIFTY chart/ }).click();
    await expect(page.locator(".td-chartbox").nth(1)).toBeHidden();
    await page.getByRole("button", { name: /Restore NIFTY chart/ }).click();
    await expect(page.locator(".td-chartbox").nth(1)).toBeVisible();
    await page.getByRole("button", { name: "← Back" }).click();
    await expect(page.locator(".pr-history")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`Practice on the website (${renderer}): a run in progress blocks Start, errors are explained`, async ({ page }) => {
    const errors = watch(page);
    await open(page, "&blocked=1");
    await page.getByRole("button", { name: /Practice/ }).click();
    await page.locator(".pr-strategies li button").click();
    await expect(page.getByRole("button", { name: "Start practice" })).toBeDisabled();
    await expect(page.getByText("A session is running. Stop it before you start a practice run.")).toBeVisible();

    // A pick the server refuses, and a start the host refuses, show their sentences and leave the screen usable.
    await open(page, "&pickerror=1");
    await page.getByRole("button", { name: /Practice/ }).click();
    await page.locator(".pr-strategies li button").click();
    await page.getByRole("button", { name: "Start practice" }).click();
    await expect(page.getByRole("alert")).toContainText("No day of this strategy with an Entry mark matches your choice");
    expect(await page.evaluate(() => (window as any).practiceStarts.length)).toBe(0);
    await open(page, "&startfail=1");
    await page.getByRole("button", { name: /Practice/ }).click();
    await page.locator(".pr-strategies li button").click();
    await page.getByRole("button", { name: "Start practice" }).click();
    await expect(page.getByRole("alert")).toContainText("Could not load that day's data");
    await expect(page.getByRole("button", { name: "Start practice" })).toBeEnabled();
    // Every matching day was already practised: the day repeats, and the screen says so.
    await open(page, "&repeated=1");
    await page.getByRole("button", { name: /Practice/ }).click();
    await page.locator(".pr-strategies li button").click();
    await page.getByRole("button", { name: "Start practice" }).click();
    await expect(page.getByText("You have practised every matching day, so this one repeats.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`Practice on the website (${renderer}): the review is refused while a session runs, and opens straight from Stop`, async ({ page }) => {
    const errors = watch(page);
    await open(page, "&review=running1");
    await expect(page.getByRole("alert")).toContainText("Stop the session first");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await open(page, "&review=ended1"); // the trading screen's Review button opens the Pattern Library on the Practice tab, in the review
    await expect(page.getByText("12 min before the first recorded entry")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).reviewOpened)).toBe(true);
    expect(errors).toEqual([]);
  });
}
