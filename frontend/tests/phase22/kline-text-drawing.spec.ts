import { test, expect } from "@playwright/test";

// The Text drawing on the KLine trading chart: one click, a box asks for the text, the drawing is saved to the backend with its
// text, shows on the chart, and a double click changes the text. Empty text or Cancel saves nothing.
test("KLine Text drawing: asks for the text, saves it with the drawing, double click changes it", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.evaluate(() => (window as any).setProps({ sharedTools: true }));
  await page.waitForFunction(() => (window as any).charts().every((c: any) => c.getDataList().length > 0));
  await page.getByRole("button", { name: "Toggle drawing and indicator tools" }).click();
  const rect = (await page.locator(".kline").first().boundingBox())!;
  const at = { x: rect.x + rect.width * 0.45, y: rect.y + rect.height * 0.35 };
  const prompt = page.getByRole("dialog", { name: "Chart text" });
  const saved = () => page.evaluate(() => (window as any).drawings.map((d: any) => d.drawing));

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.waitForTimeout(500);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(300);
  expect(await saved()).toEqual([]);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.waitForTimeout(500);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await prompt.getByLabel("Text to show on the chart").fill("Stop hunt");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(0);
  await page.waitForFunction(() => (window as any).drawings.length === 1);
  const [drawing] = await saved();
  expect(drawing.tool).toBe("Text");
  expect(drawing.text).toBe("Stop hunt");
  expect(drawing.points).toHaveLength(1);
  const extend = await page.evaluate(() => (window as any).charts()[0].getOverlays().filter((o: any) => o.name === "tmText").map((o: any) => o.extendData));
  expect(extend).toEqual([expect.objectContaining({ text: "Stop hunt" })]);
  await page.mouse.move(rect.x + 5, rect.y + 5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("text.png"), clip: rect });
  console.log("TEXTSHOT", info.outputPath("text.png"));

  const pixel = await page.evaluate(() => {
    const chart = (window as any).charts()[0];
    const o = chart.getOverlays().find((x: any) => x.name === "tmText");
    return chart.convertToPixel({ timestamp: o.points[0].timestamp, value: o.points[0].value }, { paneId: "candle_pane" });
  });
  await page.mouse.move(rect.x + pixel.x + 30, rect.y + pixel.y);
  await page.waitForTimeout(200); // the chart finds the drawing under the pointer on hover
  await page.mouse.dblclick(rect.x + pixel.x + 30, rect.y + pixel.y);
  await expect(prompt).toBeVisible();
  await expect(prompt.getByLabel("Text to show on the chart")).toHaveValue("Stop hunt");
  await prompt.getByLabel("Text to show on the chart").fill("Stop hunt, then up");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).drawings[0]?.drawing.text === "Stop hunt, then up");
  expect(errors).toEqual([]);
});
