import { test, expect, type Page } from "@playwright/test";

// The Deep Dive's Lightweight chart (the website's Lightweight renderer) has the usual drawing tools and the one indicator, EMA 9/21.
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const lastWeekday = () => { for (let back = 1; ; back += 1) { const d = new Date(); d.setDate(d.getDate() - back); if (![0, 6].includes(d.getDay())) return iso(d); } };
const store = (page: Page) => page.evaluate(() => (window as any).store);
const marks = async (page: Page) => (await store(page)).setups.reduce((n: number, s: any) => n + s.annotations.length, 0);

test("Deep Dive Lightweight chart: Indicators (EMA only) and Draw tools, without placing marks while drawing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto("/tests/phase22/deep-dive.html?renderer=lightweight", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Deep dive/ }).click();
  const selects = page.locator(".dd-start select");
  await selects.nth(0).selectOption("Breakout");
  await selects.nth(1).selectOption("Opening range");
  await page.getByRole("button", { name: "Start deep dive" }).click();
  await page.getByRole("tab", { name: /1 · Mark days/ }).waitFor();
  await page.locator(".dd-cal-cell:not([hidden])").first().waitFor();
  const day = lastWeekday();
  const cell = page.locator(".dd-cal-cell", { has: page.locator(`[aria-label^="${day}"]`) });
  for (let i = 0; i < 3 && !(await cell.isVisible()); i += 1) await page.getByRole("button", { name: "Previous month" }).click();
  await cell.getByRole("button", { name: "B", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".dd-days li").length === 1);
  await page.getByRole("tab", { name: /2 · In-depth/ }).click();
  await page.locator(".dd-chartbox canvas").first().waitFor();

  // Both charts of the day (the underlying and its CE) have the two menus.
  await expect(page.getByTitle("Indicators")).toHaveCount(2);
  await expect(page.getByTitle("Drawing tools")).toHaveCount(2);

  // Indicators: one, EMA 9/21 (no VWAP or Volume), on by default; switching it off is remembered.
  await page.getByTitle("Indicators").first().click();
  const ema = page.getByLabel("EMA 9/21");
  await expect(ema).toBeChecked();
  await expect(page.getByText("VWAP")).toHaveCount(0);
  await expect(page.getByText("Volume")).toHaveCount(0);
  await ema.uncheck();
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("analysis-lw-ema")).map(([, v]) => v))).toEqual(["0"]);
  await ema.check();
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("analysis-lw-ema")).map(([, v]) => v))).toEqual(["1"]);
  await page.mouse.click(5, 5); // close the menu

  // Draw: the usual tools.
  await page.getByTitle("Drawing tools").first().click();
  const items = page.getByRole("menuitem");
  await expect(items).toHaveCount(7);
  for (const label of ["Horizontal Line", "Trend Line", "Fib Retracement", "Rectangle", "Buy Marker", "Sell Marker", "Risk:Reward"]) await expect(items.filter({ hasText: label })).toHaveCount(1);

  // While a drawing tool is active a click on the chart draws, and is never also an Entry / Exit mark.
  await items.filter({ hasText: "Horizontal Line" }).click();
  await expect(page.getByTitle("Drawing tools").first()).toContainText("H-Line");
  await expect(page.getByText("click chart")).toBeVisible();
  const box = (await page.locator(".dd-chartbox canvas").first().boundingBox())!;
  await page.waitForTimeout(300); // the drawing tools ignore a click within 150 ms of choosing a tool (the click that chose it)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTitle("Remove the last drawing").first()).toBeVisible(); // a drawing exists
  expect(await marks(page)).toBe(0);
  // A tool draws once and switches itself off: the next click is a mark again.
  await expect(page.getByTitle("Drawing tools").first()).not.toContainText("H-Line");
  await page.getByRole("button", { name: /Entry UL/ }).click(); // no marker is selected to begin with
  // Move the pointer over the chart and press, as a person does (an instant teleport-and-click is not seen by the chart).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3, { steps: 8 });
  await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
  await page.waitForFunction(() => /1 marks/.test(document.body.textContent ?? ""));
  expect(await marks(page)).toBe(1);
  // Clear removes the last drawing.
  await page.getByTitle("Remove the last drawing").first().click();
  await expect(page.getByTitle("Remove the last drawing")).toHaveCount(0);
  expect(await marks(page)).toBe(1); // clearing drawings leaves the mark alone
  expect(errors).toEqual([]);
});
