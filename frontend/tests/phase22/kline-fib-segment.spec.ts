import { test, expect } from "@playwright/test";

// Fib Retracement on the KLine chart draws line segments over the clicked span (a little past the later click), not lines across the
// whole pane: the overlay is the segment one, and no level reaches the left edge of the chart or the price axis.
test("KLine Fib Retracement draws segments, not full-width lines", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.evaluate(() => (window as any).setProps({ sharedTools: true }));
  await page.waitForFunction(() => (window as any).charts().every((c: any) => c.getDataList().length > 0));
  await page.getByRole("button", { name: "Toggle drawing and indicator tools" }).click();
  await page.getByRole("button", { name: "Fibonacci retracement", exact: true }).click();
  await page.waitForTimeout(800);
  const rect = (await page.locator(".kline").first().boundingBox())!;
  const clicks = [[0.35, 0.3], [0.5, 0.6]];
  for (const [fx, fy] of clicks) {
    await page.mouse.move(rect.x + rect.width * fx, rect.y + rect.height * fy);
    await page.mouse.click(rect.x + rect.width * fx, rect.y + rect.height * fy);
    await page.waitForTimeout(800);
  }
  await page.waitForFunction(() => (window as any).charts()[0].getOverlays().some((o: any) => o.name === "tmFibSegment" && o.points.length >= 2));
  const names = await page.evaluate(() => (window as any).charts()[0].getOverlays().map((o: any) => o.name));
  expect(names).toContain("tmFibSegment");
  expect(names).not.toContain("fibonacciLine");
  await page.mouse.move(rect.x + 5, rect.y + 5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("fib.png"), clip: rect });
  console.log("FIBSHOT", info.outputPath("fib.png"));
  expect(errors).toEqual([]);
});
