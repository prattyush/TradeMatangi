import { test, expect } from "@playwright/test";

// The Group view: two tags together over the days where both are marked. Days: 8 marked, 6 counted (days 6 and 7 leave one tag unmarked).
const watch = (page: any) => {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (m: any) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
};

test("Results: a Group tab beside All, Buy and Sell pairs two tags over days where both are marked", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/tests/phase22/deep-dive-group.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Group", exact: true }).click();
  const group = page.getByRole("region", { name: "Two tags together" });
  await expect(group.getByTestId("group-conditional")).toContainText("When Second leg was valid, Exhaustive bar was valid 75% (3 of 4)");
  await expect(group.getByTestId("group-conditional")).toContainText("When Second leg was not valid, Exhaustive bar was valid 50% (1 of 2)");
  await expect(group.locator("tr[data-cell=both]")).toContainText("50% (3 of 6)");
  await expect(group.locator("tr[data-cell=a_only]")).toContainText("16.7% (1 of 6)");
  await expect(group.getByTestId("group-not-counted")).toContainText("6 days counted (both tags marked), 2 not counted");
  // A cell lists its days; one opens in the in-depth step.
  await group.getByRole("button", { name: "Second leg and Exhaustive bar (both valid)" }).click();
  await expect(group.getByLabel("Days").locator("li")).toHaveCount(3);
  await group.getByLabel("Days").getByRole("button").first().click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual(["2026-10-01|buy"]);
  // The days that were not counted say which tag is missing.
  await group.getByRole("button", { name: "2 not counted" }).click();
  await expect(group.getByLabel("Days")).toContainText("Exhaustive bar not marked");
  await expect(group.getByLabel("Days")).toContainText("Second leg not marked");
  // Side filter inside the view, and swapping A and B.
  await group.getByRole("group", { name: "Group side" }).getByRole("button", { name: "Sell" }).click();
  await expect(group.getByTestId("group-not-counted")).toContainText("2 days counted");
  await group.getByRole("group", { name: "Group side" }).getByRole("button", { name: "All" }).click();
  await group.getByTitle("Swap A and B").click();
  await expect(group.getByTestId("group-conditional")).toContainText("When Exhaustive bar was valid, Second leg was valid 75% (3 of 4)");
  // Choosing the same tag twice is not possible.
  await expect(group.getByLabel("Tag A").locator("option", { hasText: "Second leg" })).toHaveAttribute("disabled", "");
  // Back to All: the ordinary results are as before.
  await page.getByRole("button", { name: /^All \(8\)/ }).click();
  await expect(page.getByRole("region", { name: "Two tags together" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Label popup: a compact Group on the position's own side, only when the server sends the days", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/tests/phase22/deep-dive-group.html?view=popup", { waitUntil: "domcontentloaded" });
  const panel = page.getByRole("region", { name: "Deep dive frequencies" });
  await panel.getByRole("button", { name: "Group" }).click();
  // A bought CE is a Buy position, so the popup starts on the Buy side: days 1, 2, 3 and 8 count (day 7 lacks a tag).
  await expect(panel.getByTestId("group-conditional")).toContainText("When Second leg was valid, Exhaustive bar was valid 75% (3 of 4)");
  await expect(panel.getByTestId("group-not-counted")).toContainText("4 days counted");
  await expect(panel.getByRole("group", { name: "Group side" })).toHaveCount(0); // compact: no side switch of its own
  await panel.getByRole("button", { name: /^All/ }).click();
  await expect(panel.getByRole("region", { name: "Two tags together" })).toHaveCount(0);

  // An older server sends no days: there is no Group button and nothing else changes.
  await page.goto("/tests/phase22/deep-dive-group.html?view=popup&older=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Deep dive frequencies" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Group" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
