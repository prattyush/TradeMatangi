import { test, expect } from "@playwright/test";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weekdayBefore = () => { for (let back = 1; ; back += 1) { const d = new Date(); d.setDate(d.getDate() - back); if (![0, 6].includes(d.getDay())) return iso(d); } };

for (const renderer of ["lightweight", "kline"] as const) {
  test(`Deep Dive (${renderer}): Mark days looks at the CE and PE of a day, and the in-depth charts can sit side by side`, async ({ page }) => {
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
    const day = weekdayBefore();
    const cell = page.locator(".dd-cal-cell", { has: page.locator(`[aria-label^="${day}"]`) });
    for (let i = 0; i < 4 && !(await cell.isVisible()); i += 1) await page.getByRole("button", { name: "Previous month" }).click();
    await cell.getByRole("button", { name: "B", exact: true }).click();
    await page.locator(".dd-chart canvas").first().waitFor();

    // Mark days: the underlying is the default view; CE and PE are tabs whose strikes are the Max Price pick at 09:30, cap 75.
    const tabs = page.getByRole("tablist", { name: "Chart to look at" });
    await expect(tabs.getByRole("tab")).toHaveText(["Underlying", "CE", "PE"]);
    await expect(tabs.getByRole("tab", { name: "Underlying" })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => (window as any).strikeFinds.length)).toBe(0);
    await tabs.getByRole("tab", { name: "CE", exact: true }).click();
    await page.waitForFunction(() => (window as any).strikeFinds.some((q: any) => q.right === "CE"));
    await page.locator(".dd-chart canvas").first().waitFor();
    await tabs.getByRole("tab", { name: "PE", exact: true }).click();
    await page.waitForFunction(() => (window as any).strikeFinds.some((q: any) => q.right === "PE"));
    await page.locator(".dd-chart canvas").first().waitFor();
    const finds = await page.evaluate(() => (window as any).strikeFinds);
    for (const query of finds) { expect(query.max_price).toBe("75"); expect(query.reference_time).toBe("09:30:00"); }
    await expect(tabs.getByRole("tab", { name: "PE", exact: true })).toHaveAttribute("aria-selected", "true");
    await tabs.getByRole("tab", { name: "Underlying" }).click();
    await page.locator(".dd-chart canvas").first().waitFor();

    // In-depth: stacked by default, side by side on request, remembered when the step is left and opened again.
    await page.getByRole("tab", { name: /2 · In-depth/ }).click();
    await expect(page.locator(".dd-chartbox")).toHaveCount(2);
    const layout = page.getByRole("group", { name: "Chart layout" });
    const boxes = () => page.evaluate(() => [...document.querySelectorAll(".dd-chartbox")].map((e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), bottom: Math.round(r.bottom) }; }));
    await expect(layout.getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "true");
    let [a, b] = await boxes();
    expect(a.left).toBe(b.left); expect(b.top).toBeGreaterThan(a.top);
    await layout.getByRole("button", { name: "Side by side" }).click();
    await page.waitForTimeout(400);
    [a, b] = await boxes();
    expect(a.top).toBe(b.top); expect(b.left).toBeGreaterThan(a.left + 200);
    expect(a.width).toBeGreaterThan(300); expect(b.width).toBeGreaterThan(300);
    expect(Math.max(a.bottom, b.bottom)).toBeLessThanOrEqual(1080);
    await page.locator(".dd-chartbox canvas").nth(1).waitFor();
    await page.getByRole("tab", { name: /1 · Mark days/ }).click();
    await page.getByRole("tab", { name: /2 · In-depth/ }).click();
    await expect(layout.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
    await layout.getByRole("button", { name: "Stacked" }).click();
    await page.waitForTimeout(300);
    [a, b] = await boxes();
    expect(a.left).toBe(b.left);
    expect(errors).toEqual([]);
  });
}
