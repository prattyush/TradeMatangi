import { build } from "../frontend/node_modules/esbuild/lib/main.js";
// Supply an installed playwright-core module without adding a runtime dependency.
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactDir = resolve(
  process.env.PHASE20_ARTIFACT_DIR || root + "/.cache/phase20-validation",
);
await mkdir(artifactDir, { recursive: true });
const fixturePath = join(artifactDir, "browser-fixture.json");
execFileSync(
  process.env.PYTHON_BIN || "python3",
  [root + "/scripts/phase20-browser-fixture.py", fixturePath],
  { env: { ...process.env, PYTHONPATH: root + "/backend" } },
);
const dir = await mkdtemp(join(tmpdir(), "phase20-ui-"));
await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import Dashboard from '${root}/frontend/src/components/PerformanceDashboard.tsx';createRoot(document.getElementById('root')).render(<Dashboard onClose={()=>document.body.dataset.closed='yes'} defaultSymbol='' defaultStartDate='2026-09-01' defaultEndDate='2026-10-06' defaultInstrumentType='' defaultSessionType=''/>);`,
    resolveDir: root + "/frontend",
    loader: "tsx",
  },
  bundle: true,
  outfile: dir + "/app.js",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
await writeFile(
  dir + "/index.html",
  '<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  try {
    const file = await readFile(
      dir + (req.url === "/" ? "/index.html" : req.url),
    );
    res.setHeader(
      "Content-Type",
      req.url?.endsWith(".js")
        ? "text/javascript"
        : req.url?.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(file);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const data = JSON.parse(await readFile(fixturePath, "utf8"));
  await page.route(/\/api\/analysis\/performance/, async (route) => {
    const url = new URL(route.request().url());
    const detail = url.pathname.match(/\/cycles\/(.+)$/);
    let body = detail
      ? data.cycles.find((c) => c.cycle_id === detail[1])
      : url.pathname.endsWith("/cycles")
        ? { items: data.cycles, total: data.cycles.length, next_offset: null }
        : data.report;
    if (url.searchParams.get("enrich") === "true")
      body = {
        ...body,
        excursion: {
          status: "unavailable",
          reason: "No reliable cached observations",
        },
      };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page
    .getByRole("heading", { name: "Your trading, understood." })
    .waitFor();
  await page
    .getByRole("heading", { name: "How results accumulated" })
    .waitFor();
  for (const tab of ["Entries", "Exits", "Sizing", "Behavior", "Overview"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.screenshot({
      path: join(artifactDir, `stats-${tab.toLowerCase()}.png`),
      fullPage: false,
    });
  }
  await page.getByRole("button", { name: "Details →" }).first().click();
  await page.getByRole("dialog", { name: "Trade cycle details" }).waitFor();
  await page.getByRole("button", { name: "Analyze cached price path" }).click();
  await page.getByText("No reliable cached observations").waitFor();
  await page.getByRole("button", { name: "Close trade details" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  await download;
  await page.setViewportSize({ width: 620, height: 850 });
  await page.screenshot({ path: join(artifactDir, "stats-mobile.png") });
  await page.getByRole("button", { name: "Close analytics" }).click();
  if ((await page.evaluate(() => document.body.dataset.closed)) !== "yes")
    throw Error("Close failed");
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Dashboard browser acceptance passed: five sections, details, unavailable excursion, CSV, narrow viewport, close; no page errors",
  );
} finally {
  await browser.close();
  server.close();
}
