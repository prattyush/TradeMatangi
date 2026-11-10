import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

// Same browser lookup as webapp/: PLAYWRIGHT_CHROMIUM_EXECUTABLE, else system Chrome.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5176',
    launchOptions: { executablePath },
    screenshot: 'only-on-failure',
    // A phone in landscape; individual specs override the size.
    viewport: { width: 915, height: 412 },
    hasTouch: true,
    isMobile: false,
  },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', url: 'http://127.0.0.1:5176/', reuseExistingServer: false },
  ],
})
