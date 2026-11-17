import { test, expect } from "@playwright/test";

// Strategy Practice in the website's Analysis: a Practice badge, a filter, totals that leave practice runs out, and the review on the card.
for (const renderer of ["lightweight", "kline"] as const) {
  const open = (page: any, query = "") => page.goto(`/tests/phase22/analysis-practice.html?renderer=${renderer}${query}`, { waitUntil: "domcontentloaded" });
  const watch = (page: any) => {
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return errors;
  };

  test(`Analysis on the website (${renderer}): practice runs are badged, filterable and not in the totals`, async ({ page }) => {
    const errors = watch(page);
    await open(page);
    // The ordinary replay and the two practice runs are separate cards (a practice run never merges into the replay of that day).
    await expect(page.getByTestId("practice-badge")).toHaveCount(2);
    await expect(page.getByTestId("practice-badge").first()).toContainText("Practice: Opening range");
    await expect(page.getByRole("button", { name: /Practice review/ })).toHaveCount(2);
    // The no-trade practice run is listed (staying out is a result); an ordinary run with no trade would not be.
    await expect(page.getByText("2026-10-14")).toBeVisible();
    // Totals: only the ordinary replay counts (1 day, +500), whatever the practice runs made.
    const header = page.locator("div", { hasText: /^Days/ }).first();
    await expect(page.getByText("Total P&L").locator("xpath=following-sibling::div")).toContainText("+₹500.00");
    await expect(page.getByText("Total Trades").locator("xpath=following-sibling::div")).toHaveText("1");
    await expect(page.getByText("Days", { exact: true }).locator("xpath=following-sibling::div")).toHaveText("1");
    await expect(header).toBeVisible();

    // The filter: Exclude hides practice runs, Only shows them (and counts them).
    await page.getByLabel("Practice runs").selectOption("exclude");
    await expect(page.getByTestId("practice-badge")).toHaveCount(0);
    await expect(page.getByText("2026-10-14")).toHaveCount(0);
    await page.getByLabel("Practice runs").selectOption("only");
    await expect(page.getByTestId("practice-badge")).toHaveCount(2);
    await expect(page.getByText("Days", { exact: true }).locator("xpath=following-sibling::div")).toHaveText("2");
    await page.getByLabel("Practice runs").selectOption("include");
    expect(errors).toEqual([]);
  });

  test(`Analysis on the website (${renderer}): the Practice review opens from the card`, async ({ page }) => {
    const errors = watch(page);
    await open(page);
    // The practice run with trades is the first Review button (the cards are newest day first), the no-trade run the last.
    await page.getByRole("button", { name: /Practice review/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Practice review" });
    await expect(dialog.getByText("12 min before the first recorded entry")).toBeVisible();
    await expect(dialog.locator(".pr-recorded")).toContainText("Buy setup");
    await expect(dialog.locator(".pr-table").nth(1)).toContainText("Entered 6 min late");
    expect(await page.evaluate(() => (window as any).requests.filter((r: string) => r.startsWith("/api/deep-dive/practice/evaluate")))).toEqual(["/api/deep-dive/practice/evaluate?session_id=practice1"]);
    await dialog.getByRole("button", { name: "← Back" }).click();
    await expect(dialog).toHaveCount(0);
    // The no-trade run on a no-setup day: staying out is the right call.
    await page.getByRole("button", { name: /Practice review/ }).last().click();
    await expect(page.getByRole("dialog", { name: "Practice review" }).locator(".pr-recorded")).toContainText("you stayed out, the right call");
    expect(errors).toEqual([]);
  });

  test(`Analysis on the website (${renderer}): the review of a run that has not ended says so`, async ({ page }) => {
    await open(page, "&running=1");
    await page.getByRole("button", { name: /Practice review/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Practice review" }).getByRole("alert")).toContainText("Stop the session first");
  });
}
