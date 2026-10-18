import { expect, test } from '@playwright/test'
const site = 'http://127.0.0.1:5175'

test('website offers the same installable app without changing its own URL or worker scope', async ({ page, context, request }) => {
  await page.goto(site)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install app', exact: true })).toBeVisible()
  await expect(page.getByText('TradeMatangi app', { exact: true })).toHaveCount(0)
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/webapp/manifest.webmanifest')
  const manifest = await (await request.get(`${site}/webapp/manifest.webmanifest`)).json()
  expect(manifest).toMatchObject({ id: '/webapp/', start_url: '/webapp/', scope: '/webapp/', display: 'standalone' })
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/webapp/'))?.active?.state)).toBe('activated')
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/webapp/'))?.scope)).toBe(`${site}/webapp/`)
  const session = await context.newCDPSession(page)
  const diagnostics = await session.send('Page.getInstallabilityErrors')
  expect(diagnostics.installabilityErrors.filter((error: { errorId: string }) => error.errorId !== 'in-incognito')).toEqual([])
  await page.getByRole('button', { name: 'Install app', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Install TradeMatangi' })).toContainText('Add to Home Screen')
  const opened = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open webapp' }).click()
  const app = await opened
  await expect(app).toHaveURL(`${site}/webapp/`)
  await expect(app.getByText('TradeMatangi app', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(`${site}/`)
})

test('normal browser profile reports the website manifest as installable', async ({ playwright }, info) => {
  const context = await playwright.chromium.launchPersistentContext('', { ...info.project.use.launchOptions, headless: true })
  try {
    const page = context.pages()[0]
    await page.goto(site)
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/webapp/'))?.active?.state)).toBe('activated')
    const session = await context.newCDPSession(page)
    await expect.poll(async () => (await session.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([])
    const manifest = await session.send('Page.getAppManifest')
    expect(manifest.url).toBe(`${site}/webapp/manifest.webmanifest`)
    expect(JSON.parse(manifest.data)).toMatchObject({ id: '/webapp/', start_url: '/webapp/', scope: '/webapp/' })
  } finally { await context.close() }
})

test('website retains its one-shot install prompt across sign-in and never navigates on installation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/auth/login') || path.endsWith('/auth/me')) return route.fulfill({ json: { user_id: 'alice', email: 'alice@example.com', account_name: 'Alice', is_admin: false } })
    if (path.endsWith('/groups/active')) return route.fulfill({ status: 204 })
    if (path.endsWith('/data/symbols')) return route.fulfill({ json: { symbols: [{ symbol: 'NIFTY', name: 'NIFTY' }] } })
    if (path.endsWith('/data/available-dates')) return route.fulfill({ json: { dates: ['2026-10-16'] } })
    if (path.endsWith('/wallet')) return route.fulfill({ json: { balance: 150000 } })
    if (path.endsWith('/open-option-contracts')) return route.fulfill({ json: [] })
    return route.fulfill({ json: { settings: {}, candles: [], strategies: [], categories: [], emails: [], shared_from: [] } })
  })
  await page.goto(site)
  await page.getByRole('button', { name: 'Install app', exact: true }).waitFor()
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, { prompt: async () => { (window as any).prompts = ((window as any).prompts ?? 0) + 1 }, userChoice: Promise.resolve({ outcome: 'accepted' }) })
    window.dispatchEvent(event)
  })
  await page.getByPlaceholder('you@example.com').fill('alice@example.com')
  await page.getByPlaceholder('••••••••').fill('test-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Install app', exact: true }).click()
  expect(await page.evaluate(() => (window as any).prompts)).toBe(1)
  await expect(page).toHaveURL(`${site}/`)
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.getByRole('button', { name: 'Install app', exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
