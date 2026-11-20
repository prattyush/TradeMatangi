import { test, expect } from "@playwright/test";

const watch = (page: any) => {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
};

test("Stats day-path trend: the Day score metric scores the range once, plots the scored days and leaves gaps", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/tests/phase22/day-score-trend.html", { waitUntil: "domcontentloaded" });
  expect(await page.evaluate(() => (window as any).rangeCalls)).toEqual([]); // nothing is read until the metric is chosen
  await page.getByLabel("Day behavior trend metric").selectOption("day_score");
  await expect(page.getByTestId("score-trend-note")).toContainText("A day has a score once every closed trade");
  expect(await page.evaluate(() => (window as any).rangeCalls)).toEqual([{ start: "2026-11-10", end: "2026-11-16", compute: true }]);
  const trend = page.getByRole("img", { name: "Day score (0 to 100)" });
  await expect(trend.locator("circle")).toHaveCount(4); // 12 Nov has no score: a gap
  await expect(trend.locator("title").filter({ hasText: "2026-11-16: 91" })).toHaveCount(1);
  await expect(trend).toContainText("100"); // a fixed 0 to 100 axis
  // Back to another metric: the chart returns to it, and no more reads happen.
  await page.getByLabel("Day behavior trend metric").selectOption("max_drawdown_pct");
  await expect(page.getByRole("img", { name: "Maximum drawdown (%)" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).rangeCalls)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("Stats day-path trend: more days than one round scores are continued in further rounds", async ({ page }) => {
  await page.goto("/tests/phase22/day-score-trend.html?rounds=2", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Day behavior trend metric").selectOption("day_score");
  await expect(page.getByRole("img", { name: "Day score (0 to 100)" }).locator("circle")).toHaveCount(4);
  expect((await page.evaluate(() => (window as any).rangeCalls)).length).toBe(2);
});

test("Stats day-path trend: a failing score read is said, and a host without scores has no such metric", async ({ page }) => {
  await page.goto("/tests/phase22/day-score-trend.html?fail=1", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Day behavior trend metric").selectOption("day_score");
  await expect(page.getByTestId("score-trend-note")).toContainText("The scores could not be read: scores are down");
  await page.goto("/tests/phase22/day-score-trend.html?nosource=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Day behavior trend metric").locator("option")).toHaveCount(5);
  await expect(page.getByLabel("Day behavior trend metric").locator("option", { hasText: "Day score" })).toHaveCount(0);
});
