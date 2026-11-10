import { test, expect, type Page } from "@playwright/test";

const open = async (page: Page, mode: "kline" | "lightweight") => {
  await page.goto(`/tests/phase22/analysis-tools.html?mode=${mode}`, { waitUntil: "domcontentloaded" });
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
  await expect(rail.getByRole("button")).toHaveCount(14 + 4); // 14 tools + repeat/lock/hide/delete
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
    "─ Horizontal Line", "↗ Trend Line", "◫ Fib Retracement", "▭ Rectangle", "▲ Buy Marker", "▼ Sell Marker", "⚡ Risk:Reward",
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
