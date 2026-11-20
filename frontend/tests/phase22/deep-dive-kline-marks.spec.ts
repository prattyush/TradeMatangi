import { test, expect } from "@playwright/test";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weekdayBefore = () => { for (let back = 1; ; back += 1) { const d = new Date(); d.setDate(d.getDate() - back); if (![0, 6].includes(d.getDay())) return iso(d); } };

// Pattern marks on the KLine chart look like the Lightweight markers: an arrow outside the candle and the text beyond it, no box behind the text
// (klinecharts paints text on a blue #1677FF box unless the style says otherwise, and the old mark had no arrow at all).
test("KLine pattern marks are an arrow and plain text, not text on a blue box", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/tests/phase22/deep-dive.html?renderer=kline", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Deep dive/ }).click();
  const selects = page.locator(".dd-start select");
  await selects.nth(0).selectOption("Breakout");
  await selects.nth(1).selectOption("Opening range");
  await page.getByRole("button", { name: "Start deep dive" }).click();
  await page.getByRole("tab", { name: /1 · Mark days/ }).waitFor();
  await page.locator(".dd-cal-cell:not([hidden])").first().waitFor();
  const cell = page.locator(".dd-cal-cell", { has: page.locator(`[aria-label^="${weekdayBefore()}"]`) });
  for (let i = 0; i < 4 && !(await cell.isVisible()); i += 1) await page.getByRole("button", { name: "Previous month" }).click();
  await cell.getByRole("button", { name: "B", exact: true }).click();
  await page.getByRole("tab", { name: /2 · In-depth/ }).click();
  await page.locator(".dd-chartbox canvas").first().waitFor();
  await page.waitForTimeout(600);
  const box = (await page.locator(".dd-chartbox canvas").first().boundingBox())!;
  await page.getByRole("button", { name: /Entry UL/ }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForFunction(() => /1 marks/.test(document.body.textContent ?? ""));
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Exit UL/ }).click();
  await page.waitForTimeout(500);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.45);
  await page.waitForFunction(() => /2 marks/.test(document.body.textContent ?? ""));
  await page.mouse.move(box.x + 5, box.y + box.height - 5);
  await page.waitForTimeout(800);
  const shot = info.outputPath("marks.png");
  await page.screenshot({ path: shot, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  console.log("MARKSHOT", shot);
  // No pixel of the chart canvases is the default blue text box.
  const boxed = await page.evaluate(() => {
    let count = 0;
    for (const canvas of document.querySelectorAll(".dd-chartbox canvas")) {
      const c = canvas as HTMLCanvasElement; const ctx = c.getContext("2d"); if (!ctx || !c.width) continue;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] === 22 && data[i + 1] === 119 && data[i + 2] === 255 && data[i + 3] > 200) count += 1;
    }
    return count;
  });
  expect(boxed).toBe(0);
  expect(errors).toEqual([]);
});
