import { test, expect } from "@playwright/test";

// The Notes tab of an Analysis day: the day's note (autosaved), TODOs carried until closed, the review, and the banner in Label Trades.
for (const renderer of ["lightweight", "kline"] as const) {
  test(`Analysis Notes (${renderer}): a note autosaves, TODOs are carried and closed, the review counts them, Label Trades shows the open ones`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`/tests/phase22/analysis-notes.html?renderer=${renderer}`, { waitUntil: "domcontentloaded" });
    await page.getByText("2026-10-16").first().click();
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    const notes = page.getByLabel("Notes for 2026-10-16");
    // The TODO written on 14 Oct is carried to this day.
    const todos = notes.getByRole("region", { name: "TODOs" });
    await expect(todos.locator("li")).toHaveCount(1);
    await expect(todos.locator("li").first()).toContainText("Wait for the retest");
    await expect(todos.locator("li").first()).toContainText("from 14 Oct");
    // Type a note: it saves by itself a moment later, once, with all four parts.
    await notes.getByLabel(/What went well/).fill("  Waited for the retest  ");
    await notes.getByLabel(/Context and behaviour/).fill("Calm trend day");
    await expect(notes.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const saves = await page.evaluate(() => (window as any).noteSaves);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ date: "2026-10-16", went_well: "  Waited for the retest  ", context: "Calm trend day", to_improve: "", specific_points: "" });
    // Add a TODO of today, then mark the carried one Working and today's Done.
    await notes.getByLabel("New TODO").fill("Size down after two losses");
    await notes.getByRole("button", { name: "Add TODO" }).click();
    await expect(todos.locator("li")).toHaveCount(2);
    await expect(todos.locator("li").nth(1)).not.toContainText("from");
    await todos.getByRole("group", { name: "Status of Wait for the retest" }).getByRole("button", { name: "Working on it" }).click();
    await expect(todos.locator("li").first()).toHaveAttribute("data-status", "working");
    await todos.getByRole("group", { name: "Status of Size down after two losses" }).getByRole("button", { name: "Improved" }).click();
    await expect(todos.locator("li").nth(1)).toHaveAttribute("data-status", "improved");
    // Typing then leaving the tab at once still saves the pending text.
    await notes.getByLabel(/What to improve/).fill("Entry timing");
    await page.getByRole("button", { name: "Trades", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).noteStore.notes["2026-10-16"]))?.to_improve).toBe("Entry timing");
    // Back: the note and the TODOs are as left.
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(page.getByLabel(/What to improve/)).toHaveValue("Entry timing");
    await expect(page.getByLabel(/What went well/)).toHaveValue("Waited for the retest");
    // Review: totals, a week table, every TODO with its history.
    await page.getByText("Review: how the TODOs are going").click();
    await expect(page.getByTestId("review-totals")).toContainText("2 TODOs: 0 open, 1 working on it, 0 done, 1 improved.");
    await expect(page.locator(".dn-weeks tr[data-week='2026-10-12']")).toContainText("2"); // week of Mon 12 Oct: both written
    // Written and closed on the same day: the history keeps one entry for that day.
    await expect(page.locator(".dn-all li", { hasText: "Size down" })).toContainText("16 Oct: Improved");
    await expect(page.locator(".dn-all li", { hasText: "Wait for the retest" })).toContainText("14 Oct: Open → 16 Oct: Working on it");
    // Label Trades shows the TODOs still open (the carried one, Working) and not the closed one.
    await page.getByRole("button", { name: "Label Trades", exact: true }).click();
    const banner = page.getByRole("note", { name: "Open TODOs" });
    await expect(banner).toContainText("1 TODO to keep in mind");
    await expect(banner).toContainText("Wait for the retest");
    await expect(banner).not.toContainText("Size down");
    // Delete the carried TODO (confirm accepted): it is gone from the Notes tab.
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.getByRole("button", { name: "Delete TODO Wait for the retest" }).click();
    await expect(todos.locator("li")).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
