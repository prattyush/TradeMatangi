import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
export default defineConfig({
  testDir: "./tests/phase22",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5182",
    viewport: { width: 1200, height: 800 },
    launchOptions: { executablePath },
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5182 --strictPort",
    url: "http://127.0.0.1:5182/tests/phase22/harness.html",
    env: { VITE_DISABLE_HMR: "true", VITE_API_BASE_URL: "" },
    reuseExistingServer: false,
  },
});
