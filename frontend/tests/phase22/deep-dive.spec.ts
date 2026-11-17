import { test, expect, type Page } from "@playwright/test";

// The Deep Dive inside the website's Pattern Library page, on both Analysis & Patterns chart renderers.
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weekdaysBefore = (count: number) => {
  const out: string[] = [];
  for (let back = 1; out.length < count; back += 1) {
    const d = new Date(); d.setDate(d.getDate() - back);
    if (![0, 6].includes(d.getDay())) out.push(iso(d));
  }
  return out;
};
const store = (page: Page) => page.evaluate(() => (window as any).store);

for (const renderer of ["lightweight", "kline"] as const) {
  test(`Deep Dive on the website (${renderer}): mark days, tag them, see the results`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    const [dayA, dayB] = weekdaysBefore(2); // newest first
    await page.goto(`/tests/phase22/deep-dive.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Deep dive/ }).click();

    // Home: start a dive on an existing category and strategy.
    await page.getByText("Start a deep dive").waitFor();
    await page.getByText("No deep dives yet").waitFor();
    const selects = page.locator(".dd-start select");
    expect(await page.locator('.dd-start select[aria-label="Symbol"] option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toEqual(["NIFTY", "BSESEN", "RELIND", "TATMOT", "TATPOW"]);
    await selects.nth(0).selectOption("Breakout");
    await selects.nth(1).selectOption("Opening range");
    await page.getByRole("button", { name: "Start deep dive" }).click();
    await page.getByRole("tab", { name: /1 · Mark days/ }).waitFor();

    // Step 1: B and S per day; the selected day's chart renders.
    const cell = (date: string) => page.locator(".dd-cal-cell", { has: page.locator(`[aria-label^="${date}"]`) });
    for (const date of [dayA, dayB]) {
      for (let i = 0; i < 3 && !(await cell(date).isVisible()); i += 1) await page.getByRole("button", { name: "Previous month" }).click();
    }
    // Every day of the month sits under its own weekday header (a hidden neighbouring-month cell must not shift the grid).
    const misplaced = () => page.evaluate(() => {
      const heads = [...document.querySelectorAll(".dd-cal-dow")].map((e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; });
      return [...document.querySelectorAll(".dd-cal-cell:not([hidden]) .dd-cal-day")].flatMap((button) => {
        const date = (button.getAttribute("aria-label") ?? "").slice(0, 10);
        const r = button.getBoundingClientRect(), x = r.left + r.width / 2;
        const column = heads.reduce((best, h, i) => (Math.abs(h - x) < Math.abs(heads[best] - x) ? i : best), 0);
        const wanted = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7; // Monday first
        return column === wanted ? [] : [`${date} is under column ${column}, wanted ${wanted}`];
      });
    });
    expect(await misplaced()).toEqual([]);
    await page.getByRole("button", { name: "Previous month" }).click();
    expect(await misplaced()).toEqual([]);
    await page.getByRole("button", { name: "Next month" }).click();
    await cell(dayB).getByRole("button", { name: "B", exact: true }).click();
    await cell(dayA).getByRole("button", { name: "S", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".dd-days li").length === 2);
    await page.locator(".dd-chart canvas, .dd-chart .dd-light-canvas canvas").first().waitFor();
    expect((await store(page)).setups.map((s: any) => `${s.date}|${s.side}`).sort()).toEqual([`${dayA}|sell`, `${dayB}|buy`].sort());

    if (process.env.DD_SHOTS) await page.screenshot({ path: `${process.env.DD_SHOTS}/${renderer}-step1.png` });
    // Step 2: one underlying chart and the option chart of the day's side; tags; a mark on the chart.
    await page.getByRole("tab", { name: /2 · In-depth/ }).click();
    await page.getByText(/1 \/ 2 ·/).waitFor();
    await expect(page.locator(".dd-chartbox")).toHaveCount(2);
    await page.locator(".dd-chartbox canvas").first().waitFor();
    // The day area runs to the bottom of the window and the two stacked charts share all of it, half each: no empty half-page on a
    // tall window. On a short window each chart keeps a height where its time axis is not clipped and the page scrolls.
    const measure = () => page.evaluate(() => {
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom, height: r.height }; };
      return { day: rect(document.querySelector(".dd-day")!), charts: [...document.querySelectorAll(".dd-chartbox")].map(rect) };
    });
    for (const [width, height] of [[1920, 1080], [1600, 900]]) {
      await page.setViewportSize({ width, height });
      // The layout settles a moment after the window changes size: wait for it, then check.
      await expect.poll(async () => { const m = await measure(); return m.day.bottom > height - 40 && m.day.bottom <= height && Math.abs(m.charts[0].height - m.charts[1].height) < 4; }).toBe(true);
      const m = await measure();
      expect(m.day.bottom).toBeLessThanOrEqual(height);
      expect(m.charts).toHaveLength(2);
      expect(m.charts[1].top).toBeGreaterThan(m.charts[0].top); // stacked
      expect(m.charts[1].left).toBe(m.charts[0].left);
      expect(m.charts[0].height + m.charts[1].height).toBeGreaterThan(m.day.height * 0.75); // together they use the area
      expect(Math.abs(m.charts[0].height - m.charts[1].height)).toBeLessThan(4); // half each
      expect(m.charts[1].bottom).toBeLessThanOrEqual(height); // the lower chart and its axis are in view
      if (process.env.DD_SHOTS) await page.screenshot({ path: `${process.env.DD_SHOTS}/fill-${renderer}-${width}x${height}.png` });
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    const short = await measure();
    for (const chart of short.charts) expect(chart.height).toBeGreaterThanOrEqual(255); // never squeezed below an unclipped axis
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(page.locator(".dd-chartbox").nth(1)).toContainText(/CE 24500/); // a Buy setup is traded on its CE
    await page.getByLabel("New tag").fill("Second leg");
    await page.getByRole("button", { name: "Add tag" }).click();
    await page.getByText(/not marked on 2 days/).waitFor();
    await page.locator(".dd-taglist li", { hasText: "Second leg" }).getByRole("button", { name: "Valid", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".dd-chip.complete").length === 1);
    const box = await page.locator(".dd-chartbox canvas").first().boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForFunction(() => /1 marks/.test(document.body.textContent ?? ""));
    await page.waitForFunction(() => document.querySelector(".dd-save")?.textContent?.includes("Saved"));
    expect((await store(page)).setups.reduce((n: number, s: any) => n + s.annotations.length, 0)).toBe(1);
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.locator(".dd-chartbox").nth(1)).toContainText(/PE 24500/); // the Sell day shows its PE

    if (process.env.DD_SHOTS) await page.screenshot({ path: `${process.env.DD_SHOTS}/${renderer}-step2.png` });
    // Step 3: results.
    await page.getByRole("tab", { name: "3 · Results" }).click();
    await page.getByText("How often each tag was valid").waitFor();
    expect(await page.locator(".dd-freq li", { hasText: "Second leg" }).innerText()).toMatch(/100%\s*\(n=1\)/);
    await page.getByRole("button", { name: /^Sell \(1\)/ }).click();
    expect(await page.locator(".dd-freq li", { hasText: "Second leg" }).innerText()).toMatch(/—\s*\(n=0\)/);
    await page.getByRole("button", { name: /^All \(2\)/ }).click();
    await page.getByRole("button", { name: "Save to Patterns" }).click();
    await page.getByText(/saved as a new pattern chart with 1 mark/).waitFor();
    expect(errors).toEqual([]);
  });
}
