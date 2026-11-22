import { expect, test, type Page } from '@playwright/test'
import { fakeAppLock, fakeGoogle, mockServer, setLockMode, signIn, VIEWPORTS } from './fixtures'

const googleRequests = (server: Awaited<ReturnType<typeof mockServer>>) => server.requests.filter(r => r.path === '/api/auth/desktop/google-token')

/** Pretend the app was in the background for `ms` and came back (what the phone reports through the App plugin). */
async function leaveAppFor(page: Page, ms: number) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.evaluate(offset => {
    const real = Date.now
    Date.now = () => real() + offset
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  }, ms)
}

/** The listener for "app left / came back" is registered a moment after the switch turns on, so repeat the trip until the lock shows. */
async function leaveUntilLocked(page: Page, ms: number) {
  await expect(async () => {
    await leaveAppFor(page, ms)
    await expect(page.getByRole('dialog', { name: 'App locked' })).toBeVisible({ timeout: 700 })
  }).toPass({ timeout: 10_000 })
}

for (const viewport of VIEWPORTS) {
  test(`sign-in with the Google button fits the screen at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await mockServer(page)
    await fakeGoogle(page)
    await page.goto('/')
    const google = page.getByRole('button', { name: 'Continue with Google' })
    await expect(google).toBeVisible()
    const fits = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth <= window.innerWidth,
      bottom: document.querySelector('.login-server')!.getBoundingClientRect().bottom,
      height: window.innerHeight,
    }))
    expect(fits.horizontal).toBe(true)
    expect(fits.bottom).toBeLessThanOrEqual(fits.height)
    expect((await google.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
}

test('the Google button is not offered where the native sign-in does not exist', async ({ page }) => {
  await mockServer(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})

test('a known Google account signs in with the ID token, shows its email and keeps the Bearer flow', async ({ page }) => {
  const server = await mockServer(page)
  await fakeGoogle(page, { email: 'me@gmail.com' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await page.getByRole('navigation', { name: 'Main' }).waitFor()
  const posted = googleRequests(server)
  expect(posted).toHaveLength(1)
  expect(posted[0].body).toEqual({ id_token: 'google-id-token', device_name: 'Android phone app' })
  expect(posted[0].authorization).toBeUndefined()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click()
  await expect(page.getByText('me@gmail.com')).toBeVisible()
  await expect.poll(() => server.requests.find(r => r.path === '/api/desktop/v1/capabilities')?.authorization).toBe('Bearer access-token-1')
})

test('a Google account the server does not know asks for an account name, then creates it', async ({ page }) => {
  const server = await mockServer(page)
  server.google.known = false
  await fakeGoogle(page, { email: 'new@gmail.com', name: 'New Person' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByText('new@gmail.com has no TradeMatangi account yet')).toBeVisible()
  const name = page.getByLabel('Account name')
  await expect(name).toHaveValue('New Person')
  await name.fill('Pratt')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('navigation', { name: 'Main' }).waitFor()
  const posted = googleRequests(server)
  expect(posted).toHaveLength(2)
  expect(posted[0].body).not.toHaveProperty('account_name')
  expect(posted[1].body).toEqual({ id_token: 'google-id-token', account_name: 'Pratt', device_name: 'Android phone app' })
})

test('Back from the account-name step returns to the sign-in form without signing in', async ({ page }) => {
  const server = await mockServer(page)
  server.google.known = false
  await fakeGoogle(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
})

test('closing Google\'s chooser shows no error', async ({ page }) => {
  const server = await mockServer(page)
  await fakeGoogle(page, { failure: { code: 'cancelled' } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(googleRequests(server)).toHaveLength(0)
})

test('the 28444 setup error is explained in plain words', async ({ page }) => {
  await mockServer(page)
  await fakeGoogle(page, { failure: { code: 'failed', message: 'TYPE_UNKNOWN: failure response from one tap: 28444: Developer console is not set up correctly.' } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('alert')).toContainText('signing key')
})

test('a token the server refuses after a name was given stays on the sign-in screen', async ({ page }) => {
  const server = await mockServer(page)
  server.google.known = false
  await fakeGoogle(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  server.google.reject = true
  await page.getByLabel('Account name').fill('Pratt')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toContainText('did not accept')
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
})

test.describe('app lock', () => {
  async function openMore(page: Page) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click()
  }

  test('turning it on asks the phone first; leaving for a short time does not lock', async ({ page }) => {
    await mockServer(page)
    await fakeAppLock(page)
    await signIn(page)
    await openMore(page)
    const toggle = page.getByRole('switch')
    await expect(toggle).toBeEnabled()
    await toggle.check()
    await expect(toggle).toBeChecked()
    expect(await page.evaluate(() => (window as unknown as { __lockCalls: number }).__lockCalls)).toBe(1)
    await leaveAppFor(page, 5_000)
    await expect(page.getByRole('dialog', { name: 'App locked' })).toHaveCount(0)
  })

  test('coming back after the grace period shows the lock, which opens again after the phone confirms', async ({ page }) => {
    await mockServer(page)
    await fakeAppLock(page)
    await signIn(page)
    await openMore(page)
    await page.getByRole('switch').check()
    await setLockMode(page, 'cancelled')
    await leaveUntilLocked(page, 31_000)
    const lock = page.getByRole('dialog', { name: 'App locked' })
    // The automatic prompt was cancelled: the screen stays covered until Unlock succeeds.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lockCalls: number }).__lockCalls)).toBeGreaterThanOrEqual(2)
    await expect(lock).toBeVisible()
    await setLockMode(page, 'ok')
    await lock.getByRole('button', { name: 'Unlock' }).click()
    await expect(lock).toHaveCount(0)
  })

  test('Sign out from the lock screen ends the session and the lock', async ({ page }) => {
    await mockServer(page)
    await fakeAppLock(page)
    await signIn(page)
    await openMore(page)
    await page.getByRole('switch').check()
    await setLockMode(page, 'cancelled')
    await leaveUntilLocked(page, 31_000)
    await page.getByRole('dialog', { name: 'App locked' }).getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'App locked' })).toHaveCount(0)
  })

  test('cancelling the phone prompt leaves the lock off', async ({ page }) => {
    await mockServer(page)
    await fakeAppLock(page)
    await signIn(page)
    await openMore(page)
    await setLockMode(page, 'cancelled')
    await page.getByRole('switch').click()
    await expect(page.getByRole('switch')).not.toBeChecked()
  })

  test('is disabled with an explanation when the phone has no screen lock', async ({ page }) => {
    await mockServer(page)
    await fakeAppLock(page, { available: false })
    await signIn(page)
    await openMore(page)
    await expect(page.getByRole('switch')).toBeDisabled()
    await expect(page.getByText('Not available: this phone has no screen lock')).toBeVisible()
  })
})
