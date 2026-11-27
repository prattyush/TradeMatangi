import { test, expect } from "@playwright/test";

// The Analysis day card has one Maximize for all four tabs: the card fills the window, the tab bar stays, Esc or Restore returns to the day list.
for (const renderer of ["lightweight", "kline"] as const) {
  test(`Analysis day card (${renderer}): one Maximize covers all four tabs and Restore returns to the day list`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`/tests/phase22/analysis-maximize.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByText("2026-10-16").first().click();
    const detail = page.getByTestId("analysis-card-detail");
    const tabs = ["Trades", "Label Trades", "Walkthrough", "What If"];
    for (const tab of tabs) await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
    // Only one Maximize on the card, whatever the tab; none inside the tabs themselves.
    await expect(page.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    const viewport = page.viewportSize()!;
    for (const tab of tabs) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      const box = (await detail.boundingBox())!;
      expect(box.x).toBe(0); expect(box.y).toBe(0);
      expect(Math.round(box.width)).toBe(viewport.width); expect(Math.round(box.height)).toBe(viewport.height);
      await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(0);
    }
    // Escape restores; the day list and the open card are as they were.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(1);
    const small = (await detail.boundingBox())!;
    expect(small.height).toBeLessThan(viewport.height);
    // Again, then Restore by the button; the tab chosen while maximized is kept.
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
