import { expect, test } from '@playwright/test'
const production = 'http://127.0.0.1:5175'

test('production shell, manifest and API defaults stay under the intended paths', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const requests: string[] = []
  page.on('request', req => requests.push(req.url()))
  await page.goto(`${production}/webapp/`)
  await expect(page.getByText('TradeMatangi app', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await page.getByPlaceholder('you@example.com').fill('test@example.com')
  await page.getByPlaceholder('••••••••').fill('test-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect.poll(() => requests.some(url => url === `${production}/api/auth/login`)).toBe(true)
  expect(requests.some(url => url.includes('localhost:8701') || url.includes('localhost:8700'))).toBe(false)
  const manifest = await (await request.get(`${production}/webapp/manifest.webmanifest`)).json()
  expect(manifest).toMatchObject({ start_url: '/webapp/', scope: '/webapp/', display: 'standalone' })
  for (const icon of manifest.icons) expect((await request.get(`${production}/webapp/${icon.src}`)).ok()).toBe(true)
  expect(errors).toEqual([])
})

test('install prompt, dismiss and installation state; fullscreen exits reflect browser state', async ({ page }) => {
  await page.goto(`${production}/webapp/`)
  await page.getByRole('button', { name: 'Install app', exact: true }).click()
  await expect(page.getByText(/Add to Home Screen/)).toBeVisible()
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[aria-label="Close installation help"]')!.click()
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, { prompt: async () => { (window as any).prompted = true }, userChoice: Promise.resolve({ outcome: 'dismissed' }) })
    window.dispatchEvent(event)
  })
  await page.getByRole('button', { name: 'Install app' }).click()
  expect(await page.evaluate(() => (window as any).prompted)).toBe(true)
  await expect(page.getByRole('button', { name: 'Install app', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0)
  await page.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => document.exitFullscreen())
  await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toHaveAttribute('aria-pressed', 'false')
})

test('offline launch/retry, cache isolation, scoped control and updates waiting for open clients', async ({ page, context }) => {
  await page.goto(`${production}/webapp/`)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)
  expect(scope).toBe(`${production}/webapp/`)
  const entries = await page.evaluate(async () => {
    const names = await caches.keys()
    return Promise.all(names.map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(r => r.url) })))
  })
  expect(entries).toEqual([{ name: 'tradematangi-webapp-offline-v1', urls: [`${production}/webapp/offline.html`] }])
  // The worker passes API traffic through and does not save authenticated responses.
  await page.evaluate(() => fetch('/api/auth/me'))
  expect(await page.evaluate(async () => (await (await caches.open('tradematangi-webapp-offline-v1')).keys()).map(r => r.url))).toEqual([`${production}/webapp/offline.html`])
  await context.setOffline(true)
  await expect(page.getByRole('status').filter({ hasText: /Offline/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible()
  await context.setOffline(false)
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('TradeMatangi app', { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    await caches.open('existing-website-cache')
    await caches.open('tradematangi-webapp-offline-obsolete')
  })
  // The test server serves updated worker bytes/cache version at this URL.
  expect(await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/webapp/sw.js?version=2', { scope: '/webapp/' })
    const worker = registration.installing ?? registration.waiting
    if (worker && worker.state !== 'installed') await new Promise<void>(resolve => worker.addEventListener('statechange', () => { if (worker.state === 'installed') resolve() }))
    return Boolean(registration.waiting) && !navigator.serviceWorker.controller?.scriptURL.includes('version=2')
  })).toBe(true)
  const website = await context.newPage()
  await website.goto(`${production}/outside-scope.html`)
  expect(await website.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  await page.close()
  await expect.poll(() => website.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/webapp/')
    return registration?.active?.scriptURL.includes('version=2') && registration.active.state === 'activated' && !registration.waiting
  })).toBe(true)
  const remaining = await website.evaluate(() => caches.keys())
  expect(remaining).toContain('existing-website-cache')
  expect(remaining).toContain('tradematangi-webapp-offline-v2')
  expect(remaining).not.toContain('tradematangi-webapp-offline-v1')
  expect(remaining).not.toContain('tradematangi-webapp-offline-obsolete')
})

test('unsupported/rejected fullscreen and unavailable worker do not block the online app', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.serviceWorker.register = async () => { throw Error('Registration unavailable') }
    Element.prototype.requestFullscreen = async () => { throw Error('Fullscreen rejected') }
  })
  await page.goto(`${production}/webapp/`)
  await page.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(page.getByText(/Full screen is unavailable/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { get: () => false }))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
})

for (const viewport of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
  test(`tablet shell fits ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto(`${production}/webapp/`)
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test(`authenticated workspace and Settings stay accessible at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => localStorage.setItem('auth_user', JSON.stringify({ userId: 'alice', email: 'alice@example.com', accountName: 'Alice', isAdmin: true })))
    const candles = Array.from({ length: 200 }, (_, i) => ({ time: 1791447300 + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4, volume: 100 }))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user_id: 'alice', email: 'alice@example.com', account_name: 'Alice', is_admin: true } })
      if (path.endsWith('/groups/active')) return route.fulfill({ status: 204 })
      if (path.endsWith('/data/symbols')) return route.fulfill({ json: { symbols: [{ symbol: 'TATPOW', name: 'Tata Power' }, { symbol: 'NIFTY', name: 'NIFTY' }] } })
      if (path.endsWith('/data/available-dates')) return route.fulfill({ json: { dates: ['2026-10-08'] } })
      if (path.endsWith('/data/historical')) return route.fulfill({ json: { candles, symbol: 'TATPOW' } })
      if (path.endsWith('/wallet')) return route.fulfill({ json: { user_id: 'alice', balance: 150000, ledger_kind: 'paper', reset_allowed: true } })
      if (path.endsWith('/check-access')) return route.fulfill({ json: { has_access: false } })
      if (path.endsWith('/open-option-contracts')) return route.fulfill({ json: [] })
      if (path.endsWith('/analysis/sessions')) return route.fulfill({ json: [] })
      return route.fulfill({ json: { settings: {}, candles: [], categories: [], strategies: [], emails: [], shared_from: [] } })
    })
    await page.goto(`${production}/webapp/`)
    await expect(page.locator('canvas').first()).toBeVisible()
    await page.screenshot({ path: `test-results/workspace-${viewport.width}.png` })
    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsButton.click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(settings).toBeInViewport()
    await expect(settings.getByRole('button', { name: 'general', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: 'admin', exact: true })).toBeVisible()
    await settings.getByRole('button', { name: /close/i }).click()
    await page.getByRole('button', { name: /Analysis/ }).click()
    await expect(page.getByText('Trade Analysis', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}
