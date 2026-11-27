import { test, expect } from "@playwright/test";

const watch = (page: any) => {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
};

test("Compare: two strategies side by side, each with its own day, leg and candle interval, and nothing is written", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/tests/phase22/deep-dive-compare.html", { waitUntil: "domcontentloaded" });
  const a = page.getByRole("region", { name: "Pane A" }), b = page.getByRole("region", { name: "Pane B" });
  // Pane A starts on the first strategy and its newest day, pane B on the second; each has its day's marks and saved interval.
  await expect(a.getByTestId("chart-text")).toHaveText("NIFTY 2026-10-08 right=- strike=- marks=0 interval=3 pick=no");
  await expect(b.getByTestId("chart-text")).toHaveText("NIFTY 2026-10-09 right=- strike=- marks=1 interval=15 pick=no");
  await expect(a.getByLabel("Strategy A")).toHaveValue("me|Breakout|ORB");
  await expect(b.getByLabel("Strategy B")).toHaveValue("me|Reversal|Trap");
  // Another day of pane A: its Buy day, with its own saved interval (5) and note.
  await a.getByLabel("Day A").selectOption("2026-10-06|NIFTY|buy");
  await expect(a.getByTestId("chart-text")).toHaveText("NIFTY 2026-10-06 right=- strike=- marks=1 interval=5 pick=no");
  await expect(a).toContainText("Success (ideal)");
  await expect(a).toContainText("clean break");
  // Pane A on its CE: the day's saved strike and only the CE marks; no strike was looked up. Pane B stays on the underlying.
  await a.getByRole("tab", { name: "CE" }).click();
  await expect(a.getByTestId("chart-text")).toHaveText("NIFTY 2026-10-06 right=CE strike=24500 marks=2 interval=5 pick=no");
  await expect(a).toContainText("strike saved with the day");
  await expect(b.getByTestId("chart-text")).toContainText("right=-");
  expect(await page.evaluate(() => (window as any).strikeCalls)).toEqual([]);
  // Pane B on its PE (a Sell day) while pane A is on its CE.
  await b.getByRole("tab", { name: "PE" }).click();
  await expect(b.getByTestId("chart-text")).toHaveText("NIFTY 2026-10-09 right=PE strike=24500 marks=0 interval=15 pick=no");
  // A day without saved strikes gets the preview pick, and says so.
  await a.getByLabel("Day A").selectOption("2026-10-08|NIFTY|sell");
  await expect(a.getByTestId("chart-text")).toHaveText("NIFTY 2026-10-08 right=CE strike=24700 marks=0 interval=3 pick=no");
  await expect(a).toContainText("picked for a look");
  expect(await page.evaluate(() => (window as any).strikeCalls)).toEqual(["NIFTY|2026-10-08"]);
  // Each pane has its own interval: changing A's does not touch B's nor the shared setting.
  await a.getByRole("button", { name: "Set 10m" }).click();
  await expect(a.getByTestId("chart-text")).toContainText("interval=10");
  await expect(b.getByTestId("chart-text")).toContainText("interval=15");
  await expect(page.getByTestId("shared-interval")).toHaveText("3");
  // Both panes can be the same strategy, and pane B can switch strategy.
  await b.getByLabel("Strategy B").selectOption("me|Breakout|ORB");
  await expect(b.getByLabel("Day B")).toHaveValue("2026-10-08|NIFTY|sell");
  await expect(b.getByTestId("chart-text")).toContainText("2026-10-08");
  // Maximize one pane: it takes the area, the other is hidden; Restore brings both back.
  await a.getByRole("button", { name: /^Maximize A/ }).click();
  await expect(b).toBeHidden();
  await a.getByRole("button", { name: /^Restore A/ }).click();
  await expect(b).toBeVisible();
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Compare: nothing marked yet says so", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/tests/phase22/deep-dive-compare.html?empty=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("Nothing to compare yet");
  await expect(page.getByRole("region", { name: "Pane A" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// The real charts (KLine and Lightweight) take the pane's own candle interval and the saved strike.
for (const renderer of ["lightweight", "kline"] as const) {
  test(`Compare on the website (${renderer}): two panes with different candle intervals, a saved CE strike, nothing saved`, async ({ page }) => {
    const errors = watch(page);
    await page.goto(`/tests/phase22/deep-dive.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "🔍 Deep dive" }).waitFor();
    const mk = (date: string, side: string, interval: number) => ({ category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date, side, strike_ce: 24500, strike_pe: 24400, strike_mode: "otm",
      interval_minutes: interval, annotations: [{ id: `m${date}`, time: Date.parse(`${date}T09:30:00Z`) / 1000, price: 110, type: "entry", instrument: "underlying", strategy_name: "Opening range", category: "Breakout", text: "" }],
      outcome: null, tag_values: {}, notes: "", created_at: "", updated_at: "" });
    await page.evaluate(([a, b]) => { (window as any).store.setups.push(a, b); }, [mk("2026-10-14", "buy", 5), mk("2026-10-16", "sell", 3)]);
    const before = await page.evaluate(() => (window as any).requests.filter((r: any) => r.method !== "GET").length);
    await page.getByRole("button", { name: "⚖ Compare" }).click();
    const a = page.getByRole("region", { name: "Pane A" }), b = page.getByRole("region", { name: "Pane B" });
    await expect(a.getByLabel("Strategy A")).toBeVisible();
    // Both panes list the same strategy here; A starts on the newest day (Sell, 3m), B too, so give B the older day (Buy, 5m).
    await b.getByLabel("Day B").selectOption("2026-10-14|NIFTY|buy");
    if (renderer === "kline") {
      await expect(a.locator("header strong").first()).toContainText("3m");
      await expect(b.locator("header strong").first()).toContainText("5m");
    } else {
      await expect(a.getByLabel("Candle interval")).toHaveValue("3");
      await expect(b.getByLabel("Candle interval")).toHaveValue("5");
    }
    // Each pane on its own leg: A on its PE (a Sell day), B on its CE (a Buy day); the title carries the saved strike.
    await a.getByRole("tab", { name: "PE" }).click();
    await b.getByRole("tab", { name: "CE" }).click();
    await expect(a).toContainText("NIFTY PE 24400");
    await expect(b).toContainText("NIFTY CE 24500");
    // Changing B's interval leaves A's alone.
    if (renderer === "kline") {
      await expect(a.locator("canvas").first()).toBeVisible();
    } else {
      await b.getByLabel("Candle interval").selectOption("15");
      await expect(b.getByLabel("Candle interval")).toHaveValue("15");
      await expect(a.getByLabel("Candle interval")).toHaveValue("3");
    }
    const writes = await page.evaluate(() => (window as any).requests.filter((r: any) => r.method !== "GET").length);
    expect(writes).toBe(before); // Compare writes nothing
    expect(errors).toEqual([]);
  });
}
