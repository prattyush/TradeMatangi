import { test, expect } from "@playwright/test";

// "From your trades" inside the website's Pattern Library page, on both Analysis & Patterns chart renderers.
for (const renderer of ["lightweight", "kline"] as const) {
  test(`From your trades on the website (${renderer}): strategies, trades, traded chart, save and edit`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`/tests/phase22/deep-dive.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /From your trades/ }).click();

    // The strategies labelled on trades, with counts; the filter narrows them.
    await page.getByRole("heading", { name: /From your trades \(2\)/ }).waitFor();
    const list = page.locator(".td-strategies li");
    await expect(list).toHaveCount(2);
    await expect(list.first()).toContainText("Opening range");
    await expect(list.first()).toContainText("2 trades · 1 expected · 1 actual");
    await page.getByLabel("Filter strategies").fill("double");
    await expect(list).toHaveCount(1);
    await page.getByLabel("Filter strategies").fill("");
    await expect(page.getByText("Choose a strategy to see the trades")).toBeVisible();

    // Choose one: its trades, a long CE and a short PE (a short put is a Buy-side, bullish position).
    await list.first().getByRole("button").click();
    const rows = page.locator(".td-table tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("NIFTY CE 24500");
    await expect(rows.nth(0)).toContainText("bought");
    await expect(rows.nth(0)).toContainText("09:21 → 09:48");
    await expect(rows.nth(0)).toContainText("+1950.00");
    await expect(rows.nth(1)).toContainText("NIFTY PE 24400");
    await expect(rows.nth(1)).toContainText("sold");
    await expect(rows.nth(1)).toContainText("Buy");
    await expect(rows.nth(1)).toContainText("Actual");

    // The first trade is drawn: the underlying chart and its CE chart, side by side, with the "actual orders" legend.
    await expect(page.locator(".td-chartbox")).toHaveCount(2);
    await page.locator(".td-chartbox canvas").first().waitFor();
    await expect(page.locator(".td-chartbox").nth(1)).toContainText("NIFTY CE 24500");
    await expect(page.locator(".td-legend")).toContainText("your actual orders");
    // The viewer runs to the bottom of the window (no empty half page); the two charts are side by side at the same height and width.
    const m = await page.evaluate(() => { const r = (el: Element) => el.getBoundingClientRect(); const v = r(document.querySelector(".td-viewer")!); const [a, b] = [...document.querySelectorAll(".td-chartbox")].map(r); return { bottom: v.bottom, inner: innerHeight, row: b.left > a.left && Math.abs(b.top - a.top) < 2 && Math.abs(b.width - a.width) < 4 && Math.abs(b.height - a.height) < 2, chartBottom: Math.max(a.bottom, b.bottom), height: a.height }; });
    expect(m.row).toBe(true);
    expect(m.bottom).toBeLessThanOrEqual(m.inner + 1);
    expect(m.chartBottom).toBeLessThanOrEqual(m.inner + 1);
    expect(m.height).toBeGreaterThan(400); // full height, not half

    if (process.env.DD_SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${process.env.DD_SHOTS}/traded-${renderer}.png` }); }
    // Each chart has a Maximize button: the other hides and the chosen one takes the whole width; Restore brings both back.
    const boxes = page.locator(".td-chartbox");
    const normal = (await boxes.nth(1).boundingBox())!;
    await page.getByRole("button", { name: /Maximize .* chart/ }).nth(1).click();
    await expect(boxes.nth(0)).toBeHidden();
    const wide = (await boxes.nth(1).boundingBox())!;
    expect(wide.width).toBeGreaterThan(normal.width * 1.8);
    expect(Math.abs(wide.height - normal.height)).toBeLessThan(4);
    await page.getByRole("button", { name: /Restore .* chart/ }).click();
    await expect(boxes.nth(0)).toBeVisible();
    expect(Math.abs((await boxes.nth(1).boundingBox())!.width - normal.width)).toBeLessThan(4);
    // The short PE: its contract chart is the PE.
    await rows.nth(1).getByRole("button").click();
    await expect(page.locator(".td-chartbox").nth(1)).toContainText("NIFTY PE 24400");

    // Save as pattern chart: one request with the trade and the strategy, a plain message, nothing opens yet.
    await page.getByRole("button", { name: "Save as pattern chart" }).click();
    await page.getByText(/Saved as a new pattern chart with 2 marks/).waitFor();
    expect(await page.evaluate(() => (window as any).tradedSaves)).toEqual([{ session_id: "s2", round_trip_index: 2, category: "Breakout", strategy: "Opening range" }]);
    await expect(page.getByRole("button", { name: "Create", exact: false }).first()).toBeVisible();

    // Save and edit: the saved chart opens in Create (the page loads chart-9), with its marks.
    await page.getByRole("button", { name: "Save and edit" }).click();
    await expect.poll(async () => page.evaluate(() => (window as any).requests.some((r: any) => r.path === "/api/pattern/chart/chart-9"))).toBe(true);
    await expect(page.getByRole("button", { name: "Save Annotations" })).toBeVisible(); // Create mode, with the saved chart loaded
    await expect(page.getByText("chart saved")).toBeVisible();
    await expect(page.locator("select").filter({ hasText: "Opening range" }).first()).toHaveValue("Opening range");
    expect(await page.evaluate(() => (window as any).tradedSaves.length)).toBe(2);
    expect(errors).toEqual([]);
  });
}
