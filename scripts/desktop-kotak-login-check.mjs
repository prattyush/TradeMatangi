/** Built desktop Kotak login UX against synthetic APIs; no real credentials/orders. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";
const root = resolve(new URL("..", import.meta.url).pathname);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader(
      "Content-Type",
      extname(path) === ".js"
        ? "text/javascript"
        : extname(path) === ".css"
          ? "text/css"
          : "text/html",
    );
    res.end(
      await readFile(
        root + "/windowsapp/dist" + (path === "/" ? "/index.html" : path),
      ),
    );
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }),
  errors = [],
  calls = [];
page.on("pageerror", (error) => errors.push(String(error)));
let connected = false,
  chosen = "kotak",
  loginCount = 0;
try {
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method(),
      body = method === "GET" ? {} : req.postDataJSON() || {};
    calls.push({ path, method });
    let value = {};
    if (path.endsWith("/kotak/login")) {
      loginCount++;
      assert(/^\d{6}$/.test(body.totp));
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (loginCount === 1) {
        await route.fulfill({
          status: 502,
          json: { detail: "Invalid test authentication code" },
        });
        return;
      }
      connected = true;
      value = { status: "ok", broker: "KotakNeo" };
    } else if (path.endsWith("/auth/desktop/token"))
      value = { access_token: "synthetic" };
    else if (path.endsWith("/screens"))
      value = {
        screens: [
          {
            screen_id: "saved",
            name: "Screen 1",
            revision: 1,
            order: 0,
            active: true,
            state: {
              id: "screen",
              mode: "Real",
              layout: "1",
              tiles: [
                {
                  id: "tile",
                  symbol: "HDFCBANK",
                  kind: "equity",
                  exchange: "NSE",
                  interval: "3",
                  tradingDate: "2026-10-13",
                },
              ],
            },
          },
        ],
      };
    else if (path.endsWith("/settings/profile"))
      value = {
        email: "test@example.invalid",
        is_admin: false,
        real_trading_enabled: true,
      };
    else if (path.endsWith("/settings/broker/status"))
      value = {
        broker: chosen,
        authenticated: chosen === "kotak" && connected,
        active_sessions: [],
        active_session_id: null,
        recovery_ready: true,
      };
    else if (path.endsWith("/kotak/status"))
      value = { authenticated: connected };
    else if (path.endsWith("/breeze/status")) value = { authenticated: false };
    else if (path.endsWith("/settings/current")) {
      if (body.settings?.real_execution_broker)
        chosen = body.settings.real_execution_broker;
      value = { real_execution_broker: chosen };
    } else if (path.endsWith("/real-day-status"))
      value = { date: "2026-10-13", state: "active" };
    else if (path.endsWith("/chart-settings")) value = { settings: {} };
    else if (path.endsWith("/catalogue"))
      value = {
        instruments: [
          {
            symbol: "HDFCBANK",
            display_name: "HDFC Bank",
            exchange: "NSE",
            chart_type: "equity",
            option_eligible: true,
            supported_intervals: [1, 3, 5],
          },
        ],
      };
    else if (path.endsWith("/symbols")) value = { symbols: [] };
    else if (path.endsWith("/historical/pages"))
      value = { candles: [], available: true };
    else if (path.endsWith("/candidate"))
      value = { status: "none", active: null };
    else if (path.endsWith("/wallet"))
      value = { balance: 100000, locked: true };
    else if (path.includes("/trade-labels/metadata"))
      value = { categories: [], strategies: [], entry_tags: [], exit_tags: [] };
    await route.fulfill({ status: 200, json: value });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const connect = page.getByRole("button", {
    name: "Connect Kotak Neo",
    exact: true,
  });
  await connect.waitFor();
  assert(
    await page
      .getByRole("button", { name: "Start Real", exact: true })
      .isDisabled(),
  );
  await connect.click();
  let dialog = page.getByRole("dialog", { name: "Kotak Neo login" });
  await dialog.waitFor();
  assert(
    await page
      .getByLabel("Kotak authentication code")
      .evaluate((el) => el === document.activeElement),
  );
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  assert(await dialog.evaluate((el) => el.contains(document.activeElement)));
  await page.getByLabel("Kotak authentication code").fill("123");
  assert(
    await dialog
      .getByRole("button", { name: "Connect Kotak Neo", exact: true })
      .isDisabled(),
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(loginCount, 0);
  await connect.click();
  await page.getByLabel("Kotak authentication code").fill("1a2b3c");
  assert.equal(
    await page.getByLabel("Kotak authentication code").inputValue(),
    "123",
  );
  await page.getByLabel("Kotak authentication code").fill("123456");
  await page.getByLabel("Kotak authentication code").press("Enter");
  await dialog.getByRole("alert").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Kotak authentication code"]') ===
      document.activeElement,
  );
  assert.equal(loginCount, 1);
  assert.equal(
    await page.getByLabel("Kotak authentication code").inputValue(),
    "",
  );
  await page.getByLabel("Kotak authentication code").fill("234567");
  await page.getByLabel("Kotak authentication code").press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(loginCount, 2);
  await page.getByRole("button", { name: "Start Real", exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "Start Real", exact: true })
      .isEnabled(),
  );
  assert(!calls.some((c) => c.path.endsWith("/trading/start")));
  connected = false;
  await page.getByRole("button", { name: "Start Real", exact: true }).click();
  await page.getByRole("dialog", { name: "Kotak Neo login" }).waitFor();
  assert(!calls.some((c) => c.path.endsWith("/trading/start")));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Chart settings", exact: true })
    .click();
  await page
    .locator(".desktop-settings-modal")
    .getByRole("button", { name: "Connect Kotak Neo", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Kotak Neo login" });
  await dialog.waitFor();
  await page.getByLabel("Kotak authentication code").fill("345678");
  await page.getByLabel("Kotak authentication code").press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(loginCount, 3);
  assert(
    !calls.some(
      (c) => c.path.endsWith("/settings/current") && c.method === "PUT",
    ),
  );
  await page.getByLabel("Real execution broker").selectOption("kite");
  await page
    .locator(".desktop-settings-modal")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Check broker", exact: true }).click();
  assert.equal(
    await page.getByRole("dialog", { name: "Kotak Neo login" }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Desktop Kotak popup: toolbar/settings, cancel, validation, retry, duplicate submission, status refresh and Kite isolation passed",
  );
} finally {
  await browser.close();
  server.close();
}
