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
    // The Deep Dive's controls (back, title, steps, Prev and Next) sit in the Pattern Library's own header row: no rows of their own.
    await page.setViewportSize({ width: 1920, height: 1000 }); // wide enough for the library's tabs and the Deep Dive's controls on one line
    const y = async (locator: import("@playwright/test").Locator) => (await locator.first().boundingBox())!.y;
    const libraryTitle = await y(page.getByText("Pattern Library", { exact: true }));
    for (const control of [page.getByRole("button", { name: "All deep dives" }), page.getByRole("tab", { name: /2 · In-depth/ }), page.getByRole("button", { name: "Previous day" }), page.getByRole("button", { name: "Next day" })]) {
      expect(Math.abs((await y(control)) - libraryTitle)).toBeLessThan(10);
    }
    await page.setViewportSize({ width: 1200, height: 800 });
    // The day strip is one tab stop and the arrow keys walk the days (and focus follows).
    const chips = page.getByRole("tab", { name: /Nov|Oct|Sep|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug/ }).filter({ has: page.locator("b") });
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute("tabindex", "0");
    await expect(chips.nth(1)).toHaveAttribute("tabindex", "-1");
    await chips.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByText(/2 \/ 2 ·/).waitFor();
    await expect(chips.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowRight"); // already on the last day
    await page.getByText(/2 \/ 2 ·/).waitFor();
    await page.keyboard.press("Home");
    await page.getByText(/1 \/ 2 ·/).waitFor();
    await expect(chips.nth(0)).toBeFocused();
    // Each chart has a Maximize button: the other chart hides, the chosen one takes the whole chart area, and the choice stays when
    // walking to the next day; Restore brings both back.
    const boxes = page.locator(".dd-chartbox");
    const normal = (await boxes.nth(1).boundingBox())!;
    await page.getByRole("button", { name: /Maximize .* chart/ }).nth(1).click();
    await expect(boxes.nth(0)).toBeHidden();
    const maximized = (await boxes.nth(1).boundingBox())!;
    expect(maximized.height).toBeGreaterThan(normal.height * 1.6);
    expect(Math.abs(maximized.width - normal.width)).toBeLessThan(4);
    await page.locator("button[aria-label='Next day']").click();
    await page.getByText(/2 \/ 2 ·/).waitFor();
    await expect(boxes.nth(0)).toBeHidden(); // still maximized on the next day
    await page.getByRole("button", { name: /Restore .* chart/ }).click();
    await expect(boxes.nth(0)).toBeVisible();
    expect(Math.abs((await boxes.nth(1).boundingBox())!.height - normal.height)).toBeLessThan(4);
    await page.locator("button[aria-label='Previous day']").click();
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
    // The day shows the time of its Entry mark; Exit is still empty.
    const markedDay = (await store(page)).setups.find((x: any) => x.annotations.length);
    const seconds = markedDay.annotations[0].time % 86400;
    const markClock = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
    await expect(page.getByText(`Entry ${markClock} · Exit —`)).toBeVisible();
    // Grade the day: Failed has no grade, a grade makes it a success, one grade per day (the last click wins).
    const pressed = (name: string) => page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
    await page.getByRole("button", { name: "Failed", exact: true }).click();
    await page.getByRole("button", { name: "Ideal", exact: true }).click();
    await page.getByRole("button", { name: "Poor", exact: true }).click();
    expect([await pressed("Ideal"), await pressed("Average"), await pressed("Poor"), await pressed("Failed")]).toEqual(["false", "false", "true", "false"]);
    await page.getByRole("button", { name: "Ideal", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".dd-save")?.textContent?.includes("Saved"));
    const saved = (await store(page)).setups.find((x: any) => x.annotations.length);
    expect([saved.outcome, saved.strength]).toEqual(["success", "ideal"]);
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.locator(".dd-chartbox").nth(1)).toContainText(/PE 24500/); // the Sell day shows its PE

    // Rename a tag from another day than the one it was marked on: the name changes everywhere, the marks stay.
    await page.getByLabel("New tag").fill("Double top");
    await page.getByRole("button", { name: "Add tag" }).click();
    await expect(page.locator(".dd-taglist li", { hasText: "Double top" })).toHaveCount(1);
    await page.getByRole("button", { name: "Rename Second leg" }).click();
    await page.getByLabel("New name for Second leg").fill("Double top"); // taken by another active tag
    await page.getByLabel("New name for Second leg").press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: /already exists/ })).toBeVisible();
    expect(await page.evaluate(() => (window as any).renames ?? [])).toEqual([]); // nothing was sent
    await page.getByLabel("New name for Second leg").press("Escape"); // cancel
    await expect(page.locator(".dd-taglist li", { hasText: "Second leg" })).toHaveCount(1);
    await page.getByRole("button", { name: "Rename Second leg" }).click();
    await page.getByLabel("New name for Second leg").fill("  Second leg follows  ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".dd-taglist li", { hasText: "Second leg follows" })).toHaveCount(1);
    await expect(page.getByText(/Renamed\./)).toBeVisible();
    expect(await page.evaluate(() => (window as any).renames)).toEqual(["Second leg follows"]);
    await page.locator("button[aria-label='Previous day']").click(); // the day it was marked on: same mark, new name
    await page.getByText(/1 \/ 2 ·/).waitFor();
    await expect(page.locator(".dd-taglist li.valid", { hasText: "Second leg follows" })).toHaveCount(1);
    await page.locator("button[aria-label='Next day']").click();
    await page.getByText(/2 \/ 2 ·/).waitFor();

    if (process.env.DD_SHOTS) await page.screenshot({ path: `${process.env.DD_SHOTS}/${renderer}-step2.png` });
    // Step 3: results.
    await page.getByRole("tab", { name: "3 · Results" }).click();
    await page.getByText("How often each tag was valid").waitFor();
    await expect(page.getByText(/Ideal 1 · Average 0 · Poor 0/)).toBeVisible();
    const rows = page.locator(".dd-days-table tbody tr");
    await expect(rows.locator("td.dd-clock:nth-child(4)").filter({ hasText: markClock })).toHaveCount(1); // Entry
    expect((await rows.locator("td.dd-clock:nth-child(5)").allInnerTexts()).filter((t) => t !== "—")).toEqual([]); // no Exit marked
    await expect(rows.filter({ hasText: "Ideal" })).toHaveCount(1);
    expect(await page.locator(".dd-freq li", { hasText: "Second leg follows" }).innerText()).toMatch(/100%\s*\(n=1\)/); // the renamed tag, with its old mark
    await page.getByRole("button", { name: /^Sell \(1\)/ }).click();
    expect(await page.locator(".dd-freq li", { hasText: "Second leg" }).innerText()).toMatch(/—\s*\(n=0\)/);
    await page.getByRole("button", { name: /^All \(2\)/ }).click();
    await page.getByRole("button", { name: "Save to Patterns" }).click();
    await page.getByText(/saved as a new pattern chart with 1 mark/).waitFor();
    expect(errors).toEqual([]);
  });
}
