import { test, expect } from "@playwright/test";

// Mark days with many days marked (the owner's screenshots: a 1920 x 1080 window, and the same at 80% browser zoom, 2400 x 1350 CSS px) inside
// the app's real frame (a header above the page): the chart, and so its time axis, ends inside the window on both chart renderers, the page
// itself ends inside the window (its bottom used to be cut off by the header's height), and the list of days scrolls beside the chart.
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weekdaysBefore = (count: number) => { const out: string[] = []; for (let back = 1; out.length < count; back += 1) { const d = new Date(); d.setDate(d.getDate() - back); if (![0, 6].includes(d.getDay())) out.push(iso(d)); } return out; };

for (const renderer of ["kline", "lightweight"] as const) {
  test(`Mark days (${renderer}): the chart and its time axis end inside the window with many days marked`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/tests/phase22/deep-dive.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Deep dive/ }).click();
    const selects = page.locator(".dd-start select");
    await selects.nth(0).selectOption("Breakout");
    await selects.nth(1).selectOption("Opening range");
    await page.getByRole("button", { name: "Start deep dive" }).click();
    await page.getByRole("tab", { name: /1 · Mark days/ }).waitFor();
    await page.locator(".dd-cal-cell:not([hidden])").first().waitFor();
    const days = weekdaysBefore(21);
    for (const date of days) {
      const cell = page.locator(".dd-cal-cell", { has: page.locator(`[aria-label^="${date}"]`) });
      for (let i = 0; i < 4 && !(await cell.isVisible()); i += 1) await page.getByRole("button", { name: "Previous month" }).click();
      await cell.getByRole("button", { name: "B", exact: true }).click();
    }
    await page.waitForFunction((n) => document.querySelectorAll(".dd-days li").length === n, days.length);
    await page.locator(".dd-chart canvas").first().waitFor();
    await page.waitForTimeout(600);
    const measure = () => page.evaluate(() => {
      const chart = document.querySelector(".dd-chart")!.getBoundingClientRect();
      const canvases = [...document.querySelectorAll(".dd-chart canvas")].map((c) => c.getBoundingClientRect().bottom);
      const row = document.querySelector(".dd-mark")!.getBoundingClientRect();
      const pageBottom = document.querySelector('[data-testid="pattern-library"]')!.getBoundingClientRect().bottom;
      const left = document.querySelector(".dd-mark-left")!;
      return { top: chart.top, bottom: chart.bottom, height: chart.height, canvasBottom: Math.max(...canvases), innerHeight: window.innerHeight,
        rowBottom: row.bottom, pageBottom, leftScrolls: left.scrollHeight > left.clientHeight + 1, pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1 };
    });
    for (const [width, height] of [[1920, 1080], [2400, 1350], [1366, 700], [1200, 600]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(500);
      const m = await measure();
      expect(m.bottom, `${width}x${height}: the chart ends in the window`).toBeLessThanOrEqual(m.innerHeight);
      expect(m.canvasBottom, `${width}x${height}: so does its axis`).toBeLessThanOrEqual(m.innerHeight);
      expect(m.bottom, `${width}x${height}: and it uses the room (not a short chart)`).toBeGreaterThan(m.innerHeight - 40);
      expect(m.height).toBeGreaterThanOrEqual(360);
      expect(m.pageBottom, `${width}x${height}: the Pattern Library page ends inside the window`).toBeLessThanOrEqual(m.innerHeight);
      expect(m.rowBottom, `${width}x${height}: the whole row, calendar and list included, ends in the window`).toBeLessThanOrEqual(m.innerHeight);
      expect(m.pageScrolls, `${width}x${height}: the page itself does not scroll`).toBe(false);
      if (height <= 700) expect(m.leftScrolls, `${width}x${height}: the calendar and list scroll on their own`).toBe(true);
    }
    // The in-depth step in the same frame: both charts and their time axes end inside the window too.
    for (const [width, height] of [[1920, 1080], [2400, 1350]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole("tab", { name: /2 · In-depth/ }).click();
      await page.locator(".dd-chartbox canvas").first().waitFor();
      await page.waitForTimeout(700);
      const depth = await page.evaluate(() => ({
        boxes: [...document.querySelectorAll(".dd-chartbox")].map((e) => Math.round(e.getBoundingClientRect().bottom)),
        canvases: Math.max(...[...document.querySelectorAll(".dd-chartbox canvas")].map((c) => Math.round(c.getBoundingClientRect().bottom))),
        pageBottom: document.querySelector('[data-testid="pattern-library"]')!.getBoundingClientRect().bottom, innerHeight: window.innerHeight,
      }));
      for (const bottom of depth.boxes) expect(bottom, `${width}x${height}: in-depth chart box`).toBeLessThanOrEqual(depth.innerHeight);
      expect(depth.canvases, `${width}x${height}: in-depth axis`).toBeLessThanOrEqual(depth.innerHeight);
      expect(depth.pageBottom).toBeLessThanOrEqual(depth.innerHeight);
      await page.getByRole("tab", { name: /1 · Mark days/ }).click();
      await page.locator(".dd-chart canvas").first().waitFor();
    }
    expect(errors).toEqual([]);
  });
}
