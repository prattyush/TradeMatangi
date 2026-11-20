import { test, expect, type Page } from "@playwright/test";

const open = async (page: Page, mode: "kline" | "lightweight", volume = false) => {
  await page.goto(`/tests/phase22/analysis-tools.html?mode=${mode}${volume ? "&volume=1" : ""}`, { waitUntil: "domcontentloaded" });
};
const chartPoint = async (page: Page, selector: string, dx = 0, dy = 0) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
};

test("KLine Analysis: left rail draws, saves to the shared instrument key and restores after reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "kline");
  const rail = page.locator(".kline-tools-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("button")).toHaveCount(18 + 4); // 18 tools + repeat/lock/hide/delete
  await page.waitForSelector(".analysis-kline canvas");
  await expect(rail).toHaveAttribute("data-drawing-count", "0");

  await rail.getByRole("button", { name: "Horizontal line" }).click();
  const p = await chartPoint(page, ".analysis-kline");
  await page.mouse.click(p.x, p.y);
  await expect(rail).toHaveAttribute("data-drawing-count", "1");
  const posts = await page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "POST"));
  expect(posts).toHaveLength(1);
  expect(posts[0].body.drawing.tool).toBe("Horizontal");
  // Same identity the Day/Swing KLine charts use for the NIFTY index.
  expect(posts[0].body.instrument).toEqual({ exchange: "NSE", kind: "index", symbol: "NIFTY" });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".kline-tools-rail")).toHaveAttribute("data-drawing-count", "1");

  // A drawing click-selects it; Delete removes it from the backend.
  const q = await chartPoint(page, ".analysis-kline");
  await page.mouse.move(q.x, q.y);
  await page.mouse.click(q.x, q.y);
  // A plain click must not re-save an unmoved drawing.
  expect(await page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "PUT"))).toHaveLength(0);
  await page.keyboard.press("Delete");
  await expect(page.locator(".kline-tools-rail")).toHaveAttribute("data-drawing-count", "0");
  const deletes = await page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "DELETE"));
  expect(deletes).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("KLine Analysis: indicators persist and the rail can be hidden for every chart", async ({ page }) => {
  await open(page, "kline");
  await page.waitForSelector(".analysis-kline canvas");
  await page.getByRole("button", { name: "Indicators" }).click();
  await page.getByRole("menuitemcheckbox", { name: "VWAP" }).click();
  const stored = await page.evaluate(() => localStorage.getItem("analysis-kline-indicators:test:underlying"));
  expect(JSON.parse(stored!)).toEqual(["EMA", "VWAP"]);
  await expect(page.getByRole("menuitemcheckbox", { name: "PositionPnL" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Hide drawing tools" }).click();
  await expect(page.locator(".kline-tools-rail")).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".analysis-kline canvas");
  await expect(page.locator(".kline-tools-rail")).toHaveCount(0);
  await page.getByRole("button", { name: "Show drawing tools" }).click();
  await expect(page.locator(".kline-tools-rail")).toBeVisible();
  const indicators = await page.evaluate(() => JSON.parse(localStorage.getItem("analysis-kline-indicators:test:underlying")!));
  expect(indicators).toEqual(["EMA", "VWAP"]);
});

test("Lightweight Analysis: Chart.tsx tools, local persistence, maximize keeps drawings, EMA toggle", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "lightweight");
  await page.waitForSelector("canvas");
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);

  await page.getByRole("button", { name: "Draw ▾" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "─ Horizontal Line", "↗ Trend Line", "◫ Fib Retracement", "▭ Rectangle", "T Text", "▲ Buy Marker", "▼ Sell Marker", "⚡ Risk:Reward",
  ]);
  await page.getByRole("menuitem", { name: "─ Horizontal Line" }).click();
  await page.waitForTimeout(200); // the click that picked the tool must not draw
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  const p = await chartPoint(page, "canvas", 0, 40);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("analysis-lw-drawings:")));
  expect(key).toBe("analysis-lw-drawings::owner:NIFTY:::");
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key))).toHaveLength(1);

  // Maximize recreates the chart; the drawing must come back.
  await page.getByTitle("Maximize").click();
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas");
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();

  await page.getByRole("button", { name: "Indicators ▾" }).click();
  await page.getByLabel("EMA 9/21").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("analysis-lw-ema::owner"))).toBe("0");

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("Lightweight Analysis: Rectangle draws in two clicks, persists locally and survives reload and Clear", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "lightweight");
  await page.waitForSelector("canvas");
  await page.getByRole("button", { name: "Draw ▾" }).click();
  await page.getByRole("menuitem", { name: "▭ Rectangle" }).click();
  await page.waitForTimeout(250); // the click that picked the tool must not draw
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  const a = await chartPoint(page, "canvas", -80, -30);
  const b = await chartPoint(page, "canvas", 60, 50);
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(550); // keep the two corners from reading as a double-click
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  await page.mouse.click(b.x, b.y);
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("analysis-lw-drawings:")));
  const saved = JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key));
  expect(saved).toHaveLength(1);
  expect(saved[0].type).toBe("rect");
  expect(saved[0].p1.time).toBeLessThan(saved[0].p2.time);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas");
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("KLine Analysis panels: tools on both panes, per-contract drawings, maximize keeps them visible", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto("/tests/phase22/analysis-tools.html?mode=panels", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".analysis-underlying-pane .analysis-kline canvas");
  await page.waitForSelector(".analysis-option-pane .analysis-kline canvas");
  const rails = page.locator(".kline-tools-rail");
  await expect(rails).toHaveCount(2); // visible without maximizing

  // Draw on the option pane: saved under the exact contract key, not the underlying's.
  await rails.nth(1).getByRole("button", { name: "Trend line" }).click();
  const box = (await page.locator(".analysis-option-pane .analysis-kline").boundingBox())!;
  // klinecharts draws a segment step by step (start, second point, confirm) and needs pointer movement between clicks.
  await page.mouse.move(box.x + 150, box.y + 120);
  await page.mouse.click(box.x + 150, box.y + 120);
  await page.mouse.move(box.x + 400, box.y + 180, { steps: 8 });
  await page.mouse.click(box.x + 400, box.y + 180);
  await page.mouse.move(box.x + 420, box.y + 190, { steps: 4 });
  await page.mouse.click(box.x + 420, box.y + 190);
  await expect(rails.nth(1)).toHaveAttribute("data-drawing-count", "1");
  const post = await page.evaluate(() => (window as any).drawingLog.find((r: any) => r.method === "POST"));
  expect(post.body.instrument).toEqual({ exchange: "NSE", expiry: "2026-10-20", kind: "option", right: "CE", strike: 24500, underlying: "NIFTY" });
  await expect(rails.nth(0)).toHaveAttribute("data-drawing-count", "0");

  // Maximize the option chart: the other pane hides, the rail stays and the drawing remains.
  await page.getByRole("button", { name: "Maximize chart" }).nth(1).click();
  await expect(page.locator(".analysis-panels")).toHaveClass(/chart-maximized/);
  const maximized = await page.locator(".analysis-panels").boundingBox();
  expect(maximized).toMatchObject({ x: 0, y: 0, width: 1300, height: 800 });
  await expect(page.locator(".kline-tools-rail:visible")).toHaveCount(1);
  await expect(page.locator(".kline-tools-rail:visible")).toHaveAttribute("data-drawing-count", "1");
  await page.keyboard.press("Escape");
  await expect(page.locator(".analysis-panels")).not.toHaveClass(/chart-maximized/);
});

test("Lightweight Analysis: VWAP and Volume are offered only when the candles have volume, and the choice persists", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // An index (no volume): the menu has EMA only.
  await open(page, "lightweight");
  await page.waitForSelector("canvas");
  await page.getByRole("button", { name: "Indicators ▾" }).click();
  await expect(page.getByLabel("EMA 9/21")).toBeVisible();
  await expect(page.getByLabel("VWAP", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Volume", { exact: true })).toHaveCount(0);

  // A stock or option (volume): both are offered, off by default, and the choice is stored per account.
  await open(page, "lightweight", true);
  await page.waitForSelector("canvas");
  await page.getByRole("button", { name: "Indicators ▾" }).click();
  await expect(page.getByLabel("VWAP", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Volume", { exact: true })).not.toBeChecked();
  await page.getByLabel("VWAP", { exact: true }).check();
  await page.getByLabel("Volume", { exact: true }).check();
  expect(await page.evaluate(() => localStorage.getItem("analysis-lw-vwap::owner"))).toBe("1");
  expect(await page.evaluate(() => localStorage.getItem("analysis-lw-volume::owner"))).toBe("1");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas");
  await page.getByRole("button", { name: "Indicators ▾" }).click();
  await expect(page.getByLabel("VWAP", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Volume", { exact: true })).toBeChecked();
  // Maximize recreates the chart; the series must come back without errors.
  await page.getByTitle("Maximize").click();
  await page.getByRole("button", { name: "Indicators ▾" }).click();
  await expect(page.getByLabel("VWAP", { exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test("KLine Analysis: a Text drawing asks for its text, is saved with it, restores after reload and its text can be changed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "kline");
  const rail = page.locator(".kline-tools-rail");
  await page.waitForSelector(".analysis-kline canvas");
  const textOverlays = () => page.evaluate(() => (window as any).charts?.()?.flatMap((c: any) => c.getOverlays?.() ?? []).filter((o: any) => o.name === "tmText").map((o: any) => o.extendData));

  // Empty text drops the drawing: nothing is saved.
  await rail.getByRole("button", { name: "Text", exact: true }).click();
  const p = await chartPoint(page, ".analysis-kline", -60, -20);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  const prompt = page.getByRole("dialog", { name: "Chart text" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(rail).toHaveAttribute("data-drawing-count", "0");
  expect(await page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "POST"))).toHaveLength(0);

  // Text: typed, saved with the drawing, shown on the chart.
  await rail.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await prompt.getByLabel("Text to show on the chart").fill("Breakout retest");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(0);
  await expect(rail).toHaveAttribute("data-drawing-count", "1");
  const posts = await page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "POST"));
  expect(posts).toHaveLength(1);
  expect(posts[0].body.drawing.tool).toBe("Text");
  expect(posts[0].body.drawing.text).toBe("Breakout retest");
  expect(posts[0].body.drawing.points).toHaveLength(1);

  // Saved in the backend: it comes back after a reload, with its text.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".kline-tools-rail")).toHaveAttribute("data-drawing-count", "1");
  await page.waitForTimeout(500);
  expect(await textOverlays()).toEqual([expect.objectContaining({ text: "Breakout retest" })]);

  // A double click on the text changes it (one PUT with the new text).
  await page.locator(".analysis-kline canvas").first().waitFor();
  const box = (await page.locator(".analysis-kline").first().boundingBox())!;
  const at = await page.evaluate(() => {
    const chart = (window as any).charts().find((c: any) => c.getOverlays().some((o: any) => o.name === "tmText"));
    const overlay = chart.getOverlays().find((o: any) => o.name === "tmText");
    return chart.convertToPixel({ timestamp: overlay.points[0].timestamp, value: overlay.points[0].value }, { paneId: "candle_pane" });
  });
  await page.mouse.dblclick(box.x + at.x + 30, box.y + at.y);
  await expect(prompt).toBeVisible();
  await expect(prompt.getByLabel("Text to show on the chart")).toHaveValue("Breakout retest");
  await prompt.getByLabel("Text to show on the chart").fill("Failed breakout");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).drawingLog.some((r: any) => r.method === "PUT" && r.body.drawing.text === "Failed breakout"));
  expect(errors).toEqual([]);
});

test("Lightweight Analysis: Text asks for its text, draws it, persists locally and goes with Clear", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "lightweight");
  await page.waitForSelector("canvas");
  await page.getByRole("button", { name: "Draw ▾" }).click();
  await page.getByRole("menuitem", { name: "T Text" }).click();
  await page.waitForTimeout(250);
  const p = await chartPoint(page, "canvas", 0, 40);
  await page.mouse.click(p.x, p.y);
  const prompt = page.getByRole("dialog", { name: "Chart text" });
  await expect(prompt).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0); // nothing is drawn until it has text
  await prompt.getByLabel("Text to show on the chart").fill("Support");
  await prompt.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("analysis-lw-drawings:")));
  const saved = JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key));
  expect(saved).toEqual([expect.objectContaining({ type: "text", text: "Support" })]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas");
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("Lightweight Analysis: a drawing is picked with a click, deleted on its own, and a Text's text can be changed", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "lightweight");
  await page.waitForSelector("canvas");
  const saved = async () => {
    const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("analysis-lw-drawings:")));
    return key ? JSON.parse(await page.evaluate((k) => localStorage.getItem(k!)!, key)) : [];
  };
  const tool = async (item: string) => {
    await page.getByRole("button", { name: "Draw ▾" }).click();
    await page.getByRole("menuitem", { name: item }).click();
    await page.waitForTimeout(250);
  };
  const c = await chartPoint(page, "canvas");
  const at = (dx: number, dy: number) => ({ x: c.x + dx, y: c.y + dy });
  // Move over the chart and press, as a person does (an instant teleport-and-click is not always seen by the chart).
  const click = async (dx: number, dy: number) => {
    const p = at(dx, dy);
    await page.mouse.move(p.x - 3, p.y - 3, { steps: 6 });
    await page.waitForTimeout(150);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.waitForTimeout(150);
    await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  };
  const popup = (label: string) => page.getByRole("toolbar", { name: `${label} selected` });

  await tool("─ Horizontal Line"); await click(0, 110);
  await tool("↗ Trend Line"); await click(-220, -110); await page.waitForTimeout(550); await click(-60, -30);
  await tool("▭ Rectangle"); await click(60, -130); await page.waitForTimeout(550); await click(230, -70);
  await tool("T Text"); await click(-120, 40);
  await page.getByLabel("Text to show on the chart").fill("Support");
  await page.keyboard.press("Enter");
  expect((await saved()).map((d: any) => d.type)).toEqual(["hline", "trendline", "rect", "text"]);

  // A click on empty chart picks nothing.
  await click(200, 160);
  await expect(page.getByRole("toolbar")).toHaveCount(0);

  // Pick the trend line by a click on its middle: it is outlined and offers Delete only (no Edit text).
  await click(-140, -70);
  await expect(popup("Trend line")).toBeVisible();
  await expect(popup("Trend line").getByRole("button", { name: "Edit text" })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("picked.png") });
  await popup("Trend line").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  expect((await saved()).map((d: any) => d.type)).toEqual(["hline", "rect", "text"]);

  // The horizontal line is picked anywhere along its height; Delete key removes it.
  await click(150, 110);
  await expect(popup("Horizontal line")).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  expect((await saved()).map((d: any) => d.type)).toEqual(["rect", "text"]);

  // The rectangle is picked inside it; Escape drops the pick and nothing is deleted. The saved line width is never the thick one.
  await click(145, -100);
  await expect(popup("Rectangle")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  expect((await saved()).map((d: any) => d.type)).toEqual(["rect", "text"]);

  // Text: pick it, Edit text changes it; the text is kept in the same place.
  await click(-100, 40);
  await expect(popup("Text")).toBeVisible();
  await popup("Text").getByRole("button", { name: "Edit text" }).click();
  const prompt = page.getByRole("dialog", { name: "Chart text" });
  await expect(prompt.getByLabel("Text to show on the chart")).toHaveValue("Support");
  const before = (await saved()).find((d: any) => d.type === "text");
  await prompt.getByLabel("Text to show on the chart").fill("Resistance");
  await page.keyboard.press("Enter");
  const after = (await saved()).find((d: any) => d.type === "text");
  expect(after.text).toBe("Resistance");
  expect([after.time, after.price]).toEqual([before.time, before.price]);
  expect(await saved()).toHaveLength(2);

  // A double click on the Text opens its text box (Lightweight has no double click event of its own); Cancel leaves the text as it was.
  const q = at(-100, 40);
  await page.mouse.move(q.x - 3, q.y - 3, { steps: 4 });
  await page.waitForTimeout(150);
  await page.mouse.move(q.x, q.y, { steps: 3 });
  await page.waitForTimeout(150);
  await page.mouse.dblclick(q.x, q.y);
  await expect(prompt).toBeVisible();
  await expect(prompt.getByLabel("Text to show on the chart")).toHaveValue("Resistance");
  await prompt.getByRole("button", { name: "Cancel" }).click();
  expect((await saved()).find((d: any) => d.type === "text").text).toBe("Resistance");

  // Delete the text, then the rectangle: nothing is left, and the Clear button goes.
  await click(-100, 40);
  await popup("Text").getByRole("button", { name: "Delete" }).click();
  await click(145, -100);
  await popup("Rectangle").getByRole("button", { name: "Delete" }).click();
  expect(await saved()).toEqual([]);
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("KLine Analysis: Risk Reward (stop, then entry) and Buy / Sell markers are saved drawings that come back after a reload and can be deleted", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "kline");
  const rail = page.locator(".kline-tools-rail");
  await page.waitForSelector(".analysis-kline canvas");
  const overlays = (name: string) => page.evaluate((n) => (window as any).charts().flatMap((c: any) => c.getOverlays()).filter((o: any) => o.name === n).map((o: any) => o.points), name);
  const posts = () => page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "POST").map((r: any) => r.body.drawing));
  const press = async (x: number, y: number) => {
    await page.mouse.move(x - 3, y - 3, { steps: 6 });
    await page.waitForTimeout(150);
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(150);
    await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
    await page.waitForTimeout(200);
  };

  // Risk : Reward: the stop first (below), then the entry (above): a buy; the saved drawing has the stop as its first point.
  await rail.getByRole("button", { name: /Risk : Reward/ }).click();
  const stop = await chartPoint(page, ".analysis-kline", -120, 60);
  const entry = await chartPoint(page, ".analysis-kline", 20, -20);
  await press(stop.x, stop.y);
  await press(entry.x, entry.y);
  await expect(rail).toHaveAttribute("data-drawing-count", "1");
  let saved = await posts();
  expect(saved).toHaveLength(1);
  expect(saved[0].tool).toBe("Risk Reward");
  expect(saved[0].points).toHaveLength(2);
  expect(saved[0].points[0].price).toBeLessThan(saved[0].points[1].price); // stop below the entry
  await page.screenshot({ path: info.outputPath("rr.png") });

  // Buy and Sell markers: one click each, saved with their default text.
  await rail.getByRole("button", { name: "Buy marker" }).click();
  const buy = await chartPoint(page, ".analysis-kline", -200, -90);
  await press(buy.x, buy.y);
  await rail.getByRole("button", { name: "Sell marker" }).click();
  const sell = await chartPoint(page, ".analysis-kline", 150, 90);
  await press(sell.x, sell.y);
  await expect(rail).toHaveAttribute("data-drawing-count", "3");
  saved = await posts();
  expect(saved.map((d: any) => [d.tool, d.points.length, d.text])).toEqual([["Risk Reward", 2, undefined], ["Buy Marker", 1, "Buy UL"], ["Sell Marker", 1, "Sell UL"]]);

  // Saved in the backend: all three come back after a reload, drawn by their own overlays.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".kline-tools-rail")).toHaveAttribute("data-drawing-count", "3");
  await page.waitForTimeout(500);
  expect(await overlays("tmRiskReward")).toHaveLength(1);
  expect(await overlays("tmBuyMarker")).toHaveLength(1);
  expect(await overlays("tmSellMarker")).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("rr-restored.png") });

  // Ctrl+Z deletes the last drawing (the Sell marker): a DELETE reaches the backend.
  await page.mouse.move(entry.x, entry.y, { steps: 4 });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".kline-tools-rail")).toHaveAttribute("data-drawing-count", "2");
  expect(await page.evaluate(() => (window as any).drawingLog.filter((r: any) => r.method === "DELETE"))).toHaveLength(1);
  expect(errors).toEqual([]);
});
