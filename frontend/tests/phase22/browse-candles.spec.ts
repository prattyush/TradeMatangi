import { test, expect, type Page } from "@playwright/test";

// Browse: changing the interval must never let a scroll-back from the previous interval's oldest candle reach the new interval's data
// (found on 2026-11-22: 3m data from 27 Oct next to 5m pages from 26 Oct and before, a hole from 27 Oct to 17 Nov).
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
const firstDay = (page: Page) => page.evaluate(() => iso0((window as any).probe.data.candles[0]?.time));
const history = (page: Page) => page.evaluate(() => ((window as any).requests as string[]).filter(url => url.includes("/browse/history")));

test("a stale cursor after an interval switch is not answered, and the new interval keeps its own first load", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { (window as any).iso0 = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null); });
  await page.goto("/tests/phase22/browse-candles.html?delay=200", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("state")).toHaveText("3m · ready · 9 candles");
  expect(await firstDay(page)).toBe("2026-11-18");

  // scroll back once on 3m: the page of three older days is merged
  const older = await page.evaluate(async () => { const probe = (window as any).probe; return (await probe.data.loadOlder(probe.data.candles[0].time)).candles.length; });
  expect(older).toBeGreaterThan(0);
  await expect(page.getByTestId("state")).toHaveText("3m · ready · 18 candles");
  const oldest3m = await page.evaluate(() => (window as any).probe.data.candles[0].time as number);
  expect(iso(oldest3m)).toBe("2026-11-15");

  // switch to 5m: the render that carries the new interval has no candles of the old one, and a cursor from the 3m data is refused
  await page.evaluate(() => (window as any).probe.setInterval(5));
  await expect(page.getByTestId("state")).toHaveText("5m · loading · 0 candles");
  const stale = await page.evaluate(async cursor => (await (window as any).probe.data.loadOlder(cursor)), oldest3m);
  expect(stale).toEqual({ candles: [], more: true });
  expect((await history(page)).filter(url => url.includes("interval=5"))).toHaveLength(0);

  // the 5m first load arrives alone: nothing from the 3m data or from a page for the old cursor is in it
  await expect(page.getByTestId("state")).toHaveText("5m · ready · 9 candles");
  expect(await firstDay(page)).toBe("2026-11-18");

  // a scroll-back from the real oldest 5m candle is answered, once even when asked twice at the same time
  const [a, b] = await page.evaluate(async () => { const probe = (window as any).probe; const before = probe.data.candles[0].time; return Promise.all([probe.data.loadOlder(before), probe.data.loadOlder(before)]); });
  expect(a.candles.length).toBeGreaterThan(0);
  expect(b.candles.map((c: any) => c.time)).toEqual(a.candles.map((c: any) => c.time));
  expect((await history(page)).filter(url => url.includes("interval=5"))).toHaveLength(1);
  expect(errors).toEqual([]);
});
