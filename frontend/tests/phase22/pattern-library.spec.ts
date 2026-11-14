import { test, expect, type Page } from "@playwright/test";

const open = (page: Page, query = "") => page.goto(`/tests/phase22/pattern-library.html${query}`, { waitUntil: "domcontentloaded" });
const requests = (page: Page, path: string) =>
  page.evaluate((p) => (window as any).requests.filter((r: any) => r.path === p), path);
const loadOptionsChart = async (page: Page) => {
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("button", { name: "Load Chart" }).click();
};

test("OTM mode: ATM from the 09:15 minute price, OTM input shown, no second-level or Max Price calls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(page.getByRole("button", { name: "Load Chart" })).toBeVisible();
  await loadOptionsChart(page);
  await expect(page.getByText("ATM: 24500")).toBeVisible();
  await expect(page.getByText(/Max price: CE up to/)).toHaveCount(0);
  const price = await requests(page, "/api/data/price-at");
  expect(price).toHaveLength(1);
  expect(price[0].query).toMatchObject({ symbol: "NIFTY", time: "09:15", granularity: "minute" });
  expect(await requests(page, "/api/data/options/find-strike-by-price")).toHaveLength(0);
  const options = await requests(page, "/api/pattern/ohlc/options");
  expect(options.map((r: any) => [r.query.right, r.query.strike]).sort()).toEqual([["CE", "24500"], ["PE", "24500"]]);
  expect(errors).toEqual([]);
});

test("Max Price mode on an index: a strike per side from the caps at 09:30 on minute data, OTM input hidden", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "?mode=threshold&ce=60&pe=45");
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await expect(page.getByText("Max price: CE up to ₹60, PE up to ₹45 (Settings)")).toBeVisible();
  await expect(page.getByRole("spinbutton")).toHaveCount(0); // the OTM offset input is gone
  await page.getByRole("button", { name: "Load Chart" }).click();
  await expect(page.getByText("ATM: 24500")).toBeVisible();
  const picks = await requests(page, "/api/data/options/find-strike-by-price");
  expect(picks.map((r: any) => r.query)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ right: "CE", max_price: "60", reference_time: "09:30:00", granularity: "minute", symbol: "NIFTY" }),
      expect.objectContaining({ right: "PE", max_price: "45", reference_time: "09:30:00", granularity: "minute", symbol: "NIFTY" }),
    ]),
  );
  const options = await requests(page, "/api/pattern/ohlc/options");
  expect(options.map((r: any) => [r.query.right, r.query.strike]).sort()).toEqual([["CE", "24650"], ["PE", "24350"]]);
  expect(errors).toEqual([]);
});

test("Max Price mode: a failed pick shows the server's reason and loads no wrong strike", async ({ page }) => {
  await open(page, "?mode=threshold&fail=1");
  await loadOptionsChart(page);
  await expect(page.getByText("No observed premium at or below the cap within 30 strikes")).toBeVisible();
  expect(await requests(page, "/api/pattern/ohlc/options")).toHaveLength(0);
});

test("Saving a Max Price chart stores both strikes", async ({ page }) => {
  await open(page, "?mode=threshold");
  await loadOptionsChart(page);
  await expect(page.getByText("ATM: 24500")).toBeVisible();
  await page.getByPlaceholder("New category name…").fill("Trend");
  await page.getByPlaceholder("New strategy name…").fill("Pullback");
  await page.getByRole("button", { name: "Save Annotations" }).click();
  await expect(page.getByText("Saved!")).toBeVisible();
  const posts = (await requests(page, "/api/pattern/chart")).filter((r: any) => r.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toMatchObject({ symbol: "NIFTY", instrument_type: "options", right: "CE", strike: 24650, strike_pe: 24350 });
});

test("a stock stays OTM whatever the setting says", async ({ page }) => {
  await open(page, "?mode=threshold");
  await page.getByRole("combobox").first().selectOption("RELIND");
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await expect(page.getByRole("spinbutton")).toHaveCount(1);
  await expect(page.getByText(/Max price: CE up to/)).toHaveCount(0);
});

test("Reopening a saved chart uses its own PE strike", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "?saved=both");
  await page.getByRole("button", { name: /View/ }).click();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.getByText("CE 24650").first()).toBeVisible();
  await expect(page.getByText("PE 24350").first()).toBeVisible();
  const options = await requests(page, "/api/pattern/ohlc/options");
  expect(options.map((r: any) => [r.query.right, r.query.strike]).sort()).toEqual([["CE", "24650"], ["PE", "24350"]]);
  expect(errors).toEqual([]);
});

test("A chart saved before strike_pe still opens, with its one strike on both sides", async ({ page }) => {
  await open(page, "?saved=old");
  await page.getByRole("button", { name: /View/ }).click();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.getByText("PE 24500").first()).toBeVisible();
  const options = await requests(page, "/api/pattern/ohlc/options");
  expect(options.map((r: any) => [r.query.right, r.query.strike]).sort()).toEqual([["CE", "24500"], ["PE", "24500"]]);
});
