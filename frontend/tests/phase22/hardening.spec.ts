import { test, expect } from "@playwright/test";

// What the Deep Dive and "From your trades" say when the server cannot help: plain words, not a bare "Not Found".
for (const [server, wanted] of [["old", /does not have this feature yet/], ["down", /Could not reach the server/]] as const) {
  test(`a ${server} server: Deep dive and From your trades explain themselves and stay usable`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/tests/phase22/deep-dive.html?server=${server}`, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: /Deep dive/ }).click();
    await page.getByText("Start a deep dive").waitFor();
    await expect(page.getByRole("alert").first()).toContainText(wanted);
    await expect(page.getByRole("alert").first()).not.toContainText("Not Found");
    await expect(page.getByText("Your deep dives could not be loaded.")).toBeVisible(); // not "Loading…" forever
    // The rest of the screen still works: names load from the Pattern Library routes the old server does have.
    const selects = page.locator(".dd-start select");
    await selects.nth(0).selectOption("Breakout");
    await selects.nth(1).selectOption("Opening range");

    await page.getByRole("button", { name: /From your trades/ }).click();
    await expect(page.locator(".td-strategies").getByRole("alert")).toContainText(wanted);
    await expect(page.locator(".td-strategies").getByRole("alert")).not.toContainText("Not Found");
    expect(errors).toEqual([]);
  });
}
