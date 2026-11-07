import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
export default defineConfig({
  testDir: './tests', timeout: 30000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1200, height: 900 }, launchOptions: { executablePath }, screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', url: 'http://127.0.0.1:5174/webapp/', reuseExistingServer: false },
    { command: 'node tests/production-server.mjs', url: 'http://127.0.0.1:5175/webapp/', reuseExistingServer: false },
  ],
})
