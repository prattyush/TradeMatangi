import { expect, test } from '@playwright/test'
import { mockServer, signIn, VIEWPORTS } from './fixtures'

for (const viewport of VIEWPORTS) {
  test.describe(`landscape ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('sign-in fits the screen without page scrolling and has big enough touch targets', async ({ page }) => {
      await mockServer(page)
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
      const fits = await page.evaluate(() => ({
        horizontal: document.documentElement.scrollWidth <= window.innerWidth,
        buttonBottom: document.querySelector('button[type=submit]')!.getBoundingClientRect().bottom,
        height: window.innerHeight,
      }))
      expect(fits.horizontal).toBe(true)
      expect(fits.buttonBottom).toBeLessThanOrEqual(fits.height)
      const button = await page.getByRole('button', { name: 'Sign in' }).boundingBox()
      expect(button!.height).toBeGreaterThanOrEqual(44)
      await page.screenshot({ path: `test-results/login-${viewport.name}.png` })
    })

    test('after sign-in the rail shows six 44px+ targets and nothing scrolls sideways', async ({ page }) => {
      await mockServer(page)
      await signIn(page)
      const items = page.getByRole('navigation', { name: 'Main' }).getByRole('button')
      await expect(items).toHaveCount(6)
      for (const item of await items.all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `test-results/shell-${viewport.name}.png` })
    })
  })
}

test('signs in with the Bearer flow and sends the token on later calls', async ({ page }) => {
  const server = await mockServer(page)
  await signIn(page)
  const login = server.requests.find(r => r.path === '/api/auth/desktop/token')!
  expect(login.body).toEqual({ email: 'me@example.com', password: 'secret', device_name: 'Android phone app' })
  expect(login.authorization).toBeUndefined()
  await expect.poll(() => server.requests.some(r => r.path === '/api/desktop/v1/capabilities')).toBe(true)
  expect(server.requests.find(r => r.path === '/api/desktop/v1/capabilities')!.authorization).toBe('Bearer access-token-1')
  // The website's bare X-User-Id header is never sent: the phone is Bearer only.
  expect(server.requests.every(r => r.headers['x-user-id'] === undefined)).toBe(true)
})

test('a wrong password shows the server message and stays on the sign-in screen', async ({ page }) => {
  const server = await mockServer(page)
  server.rejectLogin = true
  await page.goto('/')
  await page.getByLabel('Email').fill('me@example.com')
  await page.getByLabel('Password').fill('nope')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid email or password')
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
})

test('an empty form asks for the details without calling the server', async ({ page }) => {
  const server = await mockServer(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Enter your email and password')
  expect(server.requests.filter(r => r.path.includes('/auth/'))).toHaveLength(0)
})

test('the server can be changed on the sign-in screen and calls go to the new host', async ({ page }) => {
  const server = await mockServer(page, ['tradematangi.co.in', 'staging.example.com'])
  await page.goto('/')
  await expect(page.getByText('Server:')).toContainText('tradematangi.co.in')
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByLabel('Server address').fill('staging.example.com')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Server:')).toContainText('staging.example.com')
  await page.getByLabel('Email').fill('me@example.com')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('navigation', { name: 'Main' }).waitFor()
  expect(server.requests.find(r => r.path === '/api/auth/desktop/token')!.host).toBe('staging.example.com')
})

test('a server address that is not https is refused in a build that forbids http', async ({ page }) => {
  await mockServer(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByLabel('Server address').fill('not a url ::')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert')).toContainText('not a valid server address')
})

test('More shows the account and server status; an old server is reported, not a crash', async ({ page }) => {
  const server = await mockServer(page)
  server.oldServer = true
  await signIn(page)
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByText('me@example.com')).toBeVisible()
  await expect(page.getByText('Older server: no capabilities endpoint')).toBeVisible()
})

test('signing out revokes the refresh token and returns to the sign-in screen', async ({ page }) => {
  const server = await mockServer(page)
  await signIn(page)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Sign out…' }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(server.requests.find(r => r.path === '/api/auth/desktop/logout')!.body).toEqual({ refresh_token: 'refresh-token-1' })
})

test('the back key returns to Sessions, then asks to press again before exiting', async ({ page }) => {
  await mockServer(page)
  await signIn(page)
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('heading', { name: 'More', level: 2 })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Sessions', level: 2 })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Press back again to exit')).toBeVisible()
})

test('going offline shows the banner and coming back removes it', async ({ page, context }) => {
  await mockServer(page)
  await signIn(page)
  await context.setOffline(true)
  await expect(page.getByText(/^Offline\./)).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText(/^Offline\./)).toHaveCount(0)
})
