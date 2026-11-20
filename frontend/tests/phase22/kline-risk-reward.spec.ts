import { test, expect } from "@playwright/test";

// Risk : Reward and Buy / Sell markers on the KLine trading chart: placed with the shared tools, saved to the backend as ordinary
// drawings (the stop is the first point of a Risk Reward), drawn by their own overlays.
test("KLine trading chart: Risk Reward (stop, then entry) and Buy / Sell markers", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.evaluate(() => (window as any).setProps({ sharedTools: true }));
  await page.waitForFunction(() => (window as any).charts().every((c: any) => c.getDataList().length > 0));
  await page.getByRole("button", { name: "Toggle drawing and indicator tools" }).click();
  const rect = (await page.locator(".kline").first().boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
  const press = async (p: { x: number; y: number }) => {
    await page.mouse.move(p.x - 3, p.y - 3, { steps: 6 });
    await page.waitForTimeout(150);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.waitForTimeout(150);
    await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const saved = () => page.evaluate(() => (window as any).drawings.map((d: any) => d.drawing));
  const names = () => page.evaluate(() => (window as any).charts()[0].getOverlays().map((o: any) => o.name));

  // Stop first (lower), then the entry (higher): a buy.
  await page.getByRole("button", { name: /Risk : Reward/ }).click();
  await page.waitForTimeout(500);
  await press(at(0.3, 0.7));
  await press(at(0.5, 0.45));
  await page.waitForFunction(() => (window as any).drawings.length === 1);
  const [rr] = await saved();
  expect(rr.tool).toBe("Risk Reward");
  expect(rr.points).toHaveLength(2);
  expect(rr.points[0].price).toBeLessThan(rr.points[1].price);
  expect(await names()).toContain("tmRiskReward");

  await page.getByRole("button", { name: "Buy marker" }).click();
  await page.waitForTimeout(500);
  await press(at(0.2, 0.3));
  await page.getByRole("button", { name: "Sell marker" }).click();
  await page.waitForTimeout(500);
  await press(at(0.7, 0.75));
  await page.waitForFunction(() => (window as any).drawings.length === 3);
  expect((await saved()).map((d: any) => [d.tool, d.text])).toEqual([["Risk Reward", undefined], ["Buy Marker", "Buy UL"], ["Sell Marker", "Sell UL"]]);
  expect(await names()).toEqual(expect.arrayContaining(["tmRiskReward", "tmBuyMarker", "tmSellMarker"]));
  await page.mouse.move(rect.x + 5, rect.y + 5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("rr.png"), clip: rect });
  console.log("RRSHOT", info.outputPath("rr.png"));
  expect(errors).toEqual([]);
});
