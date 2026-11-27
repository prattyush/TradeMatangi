import { test, expect, type Page } from "@playwright/test";

// The Analysis Summary: a card per day (figures, journey, note only when written), the day's charts on demand, and the deck.
const open = async (page: Page, query = "") => {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`/tests/phase22/analysis-summary.html${query}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Summary/ }).click();
  return errors;
};
const requests = (page: Page) => page.evaluate(() => (window as any).requests as Array<{ method: string; url: string }>);

for (const renderer of ["lightweight", "kline"] as const) {
  test(`Summary (${renderer}): cards newest first with figures, journey, best and worst, the note only when written`, async ({ page }) => {
    const errors = await open(page, `?renderer=${renderer}`);
    const cards = page.getByTestId("summary-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toHaveAttribute("data-date", "2026-10-16");
    await expect(cards.nth(2)).toHaveAttribute("data-date", "2026-10-14");
    await expect(page.getByTestId("summary-headline")).toContainText("3 days · 6 closed trades · net ₹390 · 2 up, 1 down");
    const first = cards.nth(0);
    await expect(first.getByRole("heading", { name: /Friday,? 16 Oct 2026/ })).toBeVisible();
    await expect(first.getByTestId("day-net")).toHaveText("₹380");
    await expect(first.getByLabel("Strategies of the day").getByRole("row")).toHaveCount(3); // header + Breakout + Unlabelled
    await expect(first.getByTestId("label-info")).toContainText("Labelled 2 of 3 · plan followed 2 of 2 · 1 still to label");
    await expect(first.getByText("Best trade").locator("..")).toContainText("₹400");
    await expect(first.getByText("Worst trade").locator("..")).toContainText("BANKNIFTY");
    await expect(first.getByTestId("day-score-badge")).toHaveText("Score 68");
    await expect(first.getByTestId("day-note")).toContainText("Gap-up open, trend day");
    await expect(first.getByRole("img", { name: "Cumulative completed-trade net P&L" })).toBeVisible();
    // 15 Oct: one trade still open and not counted; no note, so no note section; a score of 82.
    await expect(cards.nth(1).getByTestId("day-note")).toHaveCount(0);
    await expect(cards.nth(1)).toContainText("+1 open");
    await expect(cards.nth(1).getByTestId("day-score-badge")).toHaveText("Score 82");
    // 14 Oct: no best trade, no score yet, no note.
    await expect(cards.nth(2)).toContainText("no score yet");
    await expect(cards.nth(2).getByText("Best trade").locator("..")).toContainText("None");
    await expect(cards.nth(2).getByTestId("day-note")).toHaveCount(0);
    // Closed cards load no charts.
    const sent = (await requests(page)).map((r) => r.url);
    expect(sent.some((u) => u.includes("browse/history"))).toBe(false);
    expect(errors).toEqual([]);
  });

  test(`Summary (${renderer}): opening a card loads its daily chart and the day's chart with the Notes drawings, read only`, async ({ page }) => {
    const errors = await open(page, `?renderer=${renderer}`);
    const first = page.getByTestId("summary-card").first();
    await first.getByRole("button", { name: "Show charts" }).click();
    await expect(first.getByTestId("daily-chart")).toBeVisible();
    await expect(first.getByTestId("daily-chart")).toContainText("BANKNIFTY · daily");
    const day = first.getByLabel("Charts for 2026-10-16");
    await expect(day.getByRole("navigation", { name: "Symbol" }).getByRole("button")).toHaveText(["BANKNIFTY", "NIFTY"]);
    await expect(day.locator(".analysis-panels, .desktop-analysis-chart, canvas").first()).toBeVisible({ timeout: 15000 });
    await day.getByRole("button", { name: "NIFTY", exact: true }).click();
    await expect(first.getByTestId("daily-chart")).toContainText("NIFTY · daily");
    const sent = await requests(page);
    const daily = sent.find((r) => r.url.includes("browse/history"))!;
    expect(daily.url).toContain("interval=1440");
    expect(daily.url).toContain("days=90");
    expect(sent.some((r) => r.url.includes("drawings") && decodeURIComponent(r.url).includes("notes:2026-10-16"))).toBe(true); // the day's Notes drawings
    expect(sent.filter((r) => r.url.includes("/drawings") && r.method !== "GET")).toEqual([]); // the Summary only reads them
    await first.getByRole("button", { name: "Hide charts" }).click();
    await expect(first.getByTestId("daily-chart")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("Summary: the deck steps through the days with the buttons, arrow keys and the strip, and keeps the symbol tab", async ({ page }) => {
  const errors = await open(page);
  await page.getByRole("group", { name: "Summary layout" }).getByRole("button", { name: "Deck" }).click();
  const deck = page.getByTestId("summary-deck");
  await expect(page.getByTestId("deck-date")).toContainText("16 Oct 2026"); // the newest day first
  await expect(deck).toContainText("Day 3 of 3");
  await expect(deck.getByRole("button", { name: "Next day" })).toBeDisabled();
  // The day's charts are there at once; pick BANKNIFTY, then step back: the same symbol is shown on 15 Oct.
  const tabs = deck.getByRole("navigation", { name: "Symbol" });
  await tabs.getByRole("button", { name: "BANKNIFTY" }).click();
  await deck.getByRole("button", { name: "Previous day" }).click();
  await expect(page.getByTestId("deck-date")).toContainText("15 Oct 2026");
  await expect(deck.getByLabel("Charts for 2026-10-15").getByRole("button", { name: "BANKNIFTY" })).toHaveAttribute("aria-pressed", "true");
  // The arrow keys move one day; 14 Oct only has NIFTY, so the tab falls back to it; the first day stops the left arrow.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("deck-date")).toContainText("14 Oct 2026");
  await expect(deck.getByTestId("daily-chart")).toContainText("NIFTY · daily");
  await page.keyboard.press("ArrowLeft");
  await expect(deck).toContainText("Day 1 of 3");
  await expect(deck.getByRole("button", { name: "Previous day" })).toBeDisabled();
  await page.keyboard.press("End");
  await expect(deck).toContainText("Day 3 of 3");
  // The strip jumps to any day and shows the day you are on.
  await deck.getByRole("button", { name: /^2026-10-15/ }).click();
  await expect(page.getByTestId("deck-date")).toContainText("15 Oct 2026");
  await expect(deck.getByRole("button", { name: /^2026-10-15/ })).toHaveAttribute("aria-current", "true");
  await expect(deck.getByRole("button", { name: /^2026-10-15/ })).toHaveAttribute("aria-label", /score Replay 82/);
  // The figures and the journey sit beside the charts; the page after the first loaded its own charts only when reached.
  await expect(deck.getByTestId("day-net")).toHaveText("₹100");
  // Esc goes back to the list, and the choice of layout is remembered.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("summary-card")).toHaveCount(3);
  await page.getByRole("group", { name: "Summary layout" }).getByRole("button", { name: "Deck" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Summary/ }).click();
  await expect(page.getByTestId("summary-deck")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Summary: 'Open in deck' on a card starts the deck on that day", async ({ page }) => {
  await open(page);
  await page.getByTestId("summary-card").nth(1).getByRole("button", { name: "Open in deck" }).click();
  await expect(page.getByTestId("deck-date")).toContainText("15 Oct 2026");
});

test("Summary: the filters go to the server as the Stats filters, empty ones left out", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("summary-card")).toHaveCount(3);
  await page.getByLabel("Summary mode").selectOption("real");
  await page.getByLabel("Summary from").fill("2026-10-01");
  await page.getByLabel("Summary through").fill("2026-10-20");
  await expect.poll(async () => (await requests(page)).filter((r) => r.url.startsWith("/api/analysis/day-summary")).pop()?.url).toContain("session_type=real");
  const last = (await requests(page)).filter((r) => r.url.startsWith("/api/analysis/day-summary")).pop()!.url;
  expect(last).toContain("start_date=2026-10-01");
  expect(last).toContain("end_date=2026-10-20");
  expect(last).not.toMatch(/symbol=|client=|instrument_type=|created_from=/);
  // The symbol list offers the symbols seen; choosing one narrows the days.
  await page.getByLabel("Summary mode").selectOption("");
  await page.getByLabel("Summary symbol").selectOption("BANKNIFTY");
  await expect(page.getByTestId("summary-card")).toHaveCount(2);
});

test("Summary: an error is shown in words, an empty range says so, a cut-off range says how many days are left out", async ({ page }) => {
  await open(page, "?fail=1");
  await expect(page.getByRole("alert").filter({ hasText: "The Summary could not be loaded" })).toContainText("retry later");
  await page.goto("/tests/phase22/analysis-summary.html?empty=1", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Summary/ }).click();
  await expect(page.getByText("No trading days match these filters")).toBeVisible();
  await page.goto("/tests/phase22/analysis-summary.html?truncated=1", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Summary/ }).click();
  await expect(page.getByTestId("summary-headline")).toContainText("showing the newest 3 of 90 days");
});
