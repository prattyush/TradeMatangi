import { test, expect } from "@playwright/test";

// The Notes tab of an Analysis day: the day's note (autosaved), TODOs carried until closed, the review, and the banner in Label Trades.
for (const renderer of ["lightweight", "kline"] as const) {
  test(`Analysis Notes (${renderer}): a note autosaves, TODOs are carried and closed, the review counts them, Label Trades shows the open ones`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`/tests/phase22/analysis-notes.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByText("2026-10-16").first().click();
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    const notes = page.getByLabel("Notes for 2026-10-16");
    // The TODO written on 14 Oct is carried to this day.
    const todos = notes.getByRole("region", { name: "TODOs" });
    await expect(todos.locator("li")).toHaveCount(1);
    await expect(todos.locator("li").first()).toContainText("Wait for the retest");
    await expect(todos.locator("li").first()).toContainText("from 14 Oct");
    // Type a note: it saves by itself a moment later, once, with all four parts.
    await notes.getByLabel(/What went well/).fill("  Waited for the retest  ");
    await notes.getByLabel(/Context and behaviour/).fill("Calm trend day");
    await expect(notes.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const saves = await page.evaluate(() => (window as any).noteSaves);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ date: "2026-10-16", went_well: "  Waited for the retest  ", context: "Calm trend day", to_improve: "", specific_points: "" });
    // Add a TODO of today, then mark the carried one Working and today's Done.
    await notes.getByLabel("New TODO").fill("Size down after two losses");
    await notes.getByRole("button", { name: "Add TODO" }).click();
    await expect(todos.locator("li")).toHaveCount(2);
    await expect(todos.locator("li").nth(1)).not.toContainText("from");
    await todos.getByRole("group", { name: "Status of Wait for the retest" }).getByRole("button", { name: "Working on it" }).click();
    await expect(todos.locator("li").first()).toHaveAttribute("data-status", "working");
    await todos.getByRole("group", { name: "Status of Size down after two losses" }).getByRole("button", { name: "Improved" }).click();
    await expect(todos.locator("li").nth(1)).toHaveAttribute("data-status", "improved");
    // Typing then leaving the tab at once still saves the pending text.
    await notes.getByLabel(/What to improve/).fill("Entry timing");
    await page.getByRole("button", { name: "Trades", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).noteStore.notes["2026-10-16"]))?.to_improve).toBe("Entry timing");
    // Back: the note and the TODOs are as left.
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(page.getByLabel(/What to improve/)).toHaveValue("Entry timing");
    await expect(page.getByLabel(/What went well/)).toHaveValue("Waited for the retest");
    // Review: totals, a week table, every TODO with its history.
    await page.getByText("Review: how the TODOs are going").click();
    await expect(page.getByTestId("review-totals")).toContainText("2 TODOs: 0 open, 1 working on it, 0 done, 1 improved.");
    await expect(page.locator(".dn-weeks tr[data-week='2026-10-12']")).toContainText("2"); // week of Mon 12 Oct: both written
    // Written and closed on the same day: the history keeps one entry for that day.
    await expect(page.locator(".dn-all li", { hasText: "Size down" })).toContainText("16 Oct: Improved");
    await expect(page.locator(".dn-all li", { hasText: "Wait for the retest" })).toContainText("14 Oct: Open → 16 Oct: Working on it");
    // Label Trades shows the TODOs still open (the carried one, Working) and not the closed one.
    await page.getByRole("button", { name: "Label Trades", exact: true }).click();
    const banner = page.getByRole("note", { name: "Open TODOs" });
    await expect(banner).toContainText("1 TODO to keep in mind");
    await expect(banner).toContainText("Wait for the retest");
    await expect(banner).not.toContainText("Size down");
    // Delete the carried TODO (confirm accepted): it is gone from the Notes tab.
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.getByRole("button", { name: "Delete TODO Wait for the retest" }).click();
    await expect(todos.locator("li")).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

// The day score: a chip on the day card, and its breakdown in the Notes tab.
test("Analysis day score: a stored score shows on the card, the full score and its breakdown come with the open card", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto("/tests/phase22/analysis-notes.html?renderer=lightweight", { waitUntil: "domcontentloaded" });
  // The list reads the stored scores once (nothing is computed for a closed card): the chip shows already.
  await expect(page.getByTestId("day-score-badge")).toHaveText("Score 68");
  expect(await page.evaluate(() => (window as any).scoreRanges)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).scoreRanges[0])).not.toContain("compute");
  expect(await page.evaluate(() => (window as any).scoreReads)).toEqual([]);
  // Opening the card reads the day's full score; the chip follows it.
  await page.getByText("2026-10-16").first().click();
  await expect(page.getByTestId("day-score-badge")).toHaveText("Score 72");
  await expect(page.getByTestId("day-score-badge")).toHaveClass(/fair/);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const score = page.getByRole("region", { name: "Day score" });
  await expect(score.getByTestId("score-value")).toHaveText("72");
  await expect(score.locator("tr[data-rule]")).toHaveCount(5);
  // The costly rule is first, the bonus last.
  await expect(score.locator("tr[data-rule]").first()).toHaveAttribute("data-rule", "drawdown");
  await expect(score.locator("tr[data-rule]").last()).toHaveAttribute("data-rule", "clean_day");
  await expect(score.locator("tr[data-rule=drawdown]")).toContainText("−8");
  await expect(score.locator("tr[data-rule=clean_day]")).toContainText("+15");
  await expect(score).toContainText("6.2% of capital against a 10% guardrail limit (52% of it)");
  await expect(score.getByRole("note")).toHaveCount(0); // saved limit, full candles: nothing to warn about
  // Changing tabs reads the score again (a label saved in Label Trades is in it by then).
  const reads = (await page.evaluate(() => (window as any).scoreReads)).length;
  await page.getByRole("button", { name: "Trades", exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).scoreReads)).length).toBeGreaterThan(reads);
  expect(errors).toEqual([]);
});

test("Analysis day score: an estimated limit and partial candles are said, and a day with unlabelled trades has no chip", async ({ page }) => {
  await page.goto("/tests/phase22/analysis-notes.html?renderer=lightweight&score=estimated", { waitUntil: "domcontentloaded" });
  await page.getByText("2026-10-16").first().click();
  await expect(page.getByTestId("day-score-badge")).toHaveText("Score 41");
  await expect(page.getByTestId("day-score-badge")).toHaveClass(/poor/);
  await expect(page.getByTestId("day-score-badge")).toHaveAttribute("title", /limit estimated, partial candles/);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("region", { name: "Day score" }).getByRole("note")).toContainText("estimated at 12%");
  await expect(page.getByRole("region", { name: "Day score" }).getByRole("note")).toContainText("candles were missing");

  await page.goto("/tests/phase22/analysis-notes.html?renderer=lightweight&score=pending", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("day-score-badge")).toHaveText("Score 68"); // the stored one, until the card says otherwise
  await page.getByText("2026-10-16").first().click();
  await expect(page.getByTestId("day-score-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByTestId("score-pending")).toHaveText("Label the last closed trade (3 of 4 labelled) to get the day's score.");
});

// The Notes tab's chart of the whole day (Phase 27, S9) and the rules of the score that open on a click.
for (const renderer of ["lightweight", "kline"] as const) {
  test(`Analysis Notes (${renderer}): the day's chart has a tab per symbol and keeps its drawings in the day's own namespace`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`/tests/phase22/analysis-notes.html?renderer=${renderer}&symbols=2`, { waitUntil: "domcontentloaded" });
    // Two symbols on the date are two cards; the Notes tab of either one is the date's.
    await page.getByText("2026-10-16").first().click();
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    const notes = page.getByLabel("Notes for 2026-10-16");
    await expect(notes.getByRole("heading", { level: 3 })).toContainText(/Friday,? 16 Oct 2026/);
    const chart = notes.getByLabel("Charts for 2026-10-16");
    const tabs = chart.getByRole("navigation", { name: "Symbol" });
    await expect(tabs.getByRole("button")).toHaveText(["BANKNIFTY", "NIFTY"]);
    await expect(tabs.getByRole("button", { name: "BANKNIFTY", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(chart.locator("canvas").first()).toBeVisible();
    // Its drawings are asked for in the day's own namespace, never the plain one only.
    const scopedReads = () => page.evaluate(() => ((window as any).requests as string[]).filter((r) => r.includes("drawings?instrument=") && decodeURIComponent(r).includes('"drawing_scope":"notes:2026-10-16"')).length);
    await expect.poll(scopedReads).toBeGreaterThan(0);
    // The other symbol: its candles are asked for and the NIFTY chart (with its CE tab) opens.
    await tabs.getByRole("button", { name: "NIFTY", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "NIFTY", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(chart.locator("canvas").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => ((window as any).requests as string[]).filter((r) => r.includes("symbol=NIFTY")).length)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

test("Analysis Notes: a rule of the day score opens on a click to say why it counts, how the points are set and what was found", async ({ page }) => {
  await page.goto("/tests/phase22/analysis-notes.html?score=scored", { waitUntil: "domcontentloaded" });
  await page.getByText("2026-10-16").first().click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const score = page.getByLabel("Notes for 2026-10-16").getByRole("region", { name: "Day score" });
  const drawdown = score.getByRole("button", { name: /Drawdown against the guardrail limit/ });
  await expect(drawdown).toHaveAttribute("aria-expanded", "false");
  await expect(score.locator(".ds-help")).toHaveCount(0);
  await drawdown.click();
  await expect(drawdown).toHaveAttribute("aria-expanded", "true");
  const help = score.locator(".ds-help");
  await expect(help).toContainText("Why it counts.");
  await expect(help).toContainText("50% of the limit −8, 75% of the limit −14, 100% of the limit −25, 150% of the limit −35");
  // One open at a time: another rule replaces it; a second click closes it.
  await score.getByRole("button", { name: /Repeat entries after a loss/ }).click();
  await expect(help).toHaveCount(1);
  await expect(help).toContainText("within 3 bars (9 minutes on 3-minute bars)");
  await score.getByRole("button", { name: /Repeat entries after a loss/ }).click();
  await expect(score.locator(".ds-help")).toHaveCount(0);
});
