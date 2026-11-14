import { expect, test, type Page } from '@playwright/test'
import { mockServer, signIn, VIEWPORTS, type MockServer } from './fixtures'

async function openStats(page: Page, server?: (state: MockServer) => void) {
  const state = await mockServer(page)
  server?.(state)
  await signIn(page)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Stats' }).click()
  return state
}
const mode = (page: Page) => page.locator('.pa-overlay > .pa-filters label', { hasText: /^Mode/ }).locator('select')
const tab = (page: Page, name: string) => page.locator('.pa-tabs').getByRole('button', { name, exact: true })

test('Overview shows the numbers for the last 30 days and sends the signed-in request', async ({ page }) => {
  const state = await openStats(page)
  await expect(page.getByText('Realized P&L').first()).toBeVisible()
  await expect(page.locator('.pa-kpi').first()).toContainText('₹1,950')
  await expect(page.getByRole('heading', { name: 'How results accumulated' })).toBeVisible()
  const request = state.requests.find(r => r.path === '/api/desktop/v1/analysis/performance')!
  expect(request.authorization).toBe('Bearer access-token-1')
  const days = (new Date(request.query.get('end_date')!).getTime() - new Date(request.query.get('start_date')!).getTime()) / 86_400_000
  expect(days).toBe(29)
  expect(request.query.get('trading_style')).toBe('intraday')
})

test('each section has its own content', async ({ page }) => {
  await openStats(page)
  await expect(page.getByRole('heading', { name: 'Outcome distribution' })).toBeAttached()
  await tab(page, 'Entries').click()
  await expect(page.getByRole('heading', { name: /Entry → exit combinations/ })).toBeVisible()
  await tab(page, 'Exits').click()
  await expect(page.getByRole('heading', { name: /Half versus Full exit intent/ })).toBeVisible()
  await tab(page, 'Sizing').click()
  await expect(page.getByRole('heading', { name: /Size versus outcome/ })).toBeVisible()
  await tab(page, 'Behavior').click()
  await expect(page.getByRole('heading', { name: /Patterns worth reviewing/ })).toBeVisible()
  await expect(tab(page, 'Behavior')).toHaveAttribute('aria-pressed', 'true')
})

test('the filters open in a panel, apply, and the back key closes the panel', async ({ page }) => {
  const state = await openStats(page)
  await expect(mode(page)).toBeHidden()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(mode(page)).toBeVisible()
  await mode(page).selectOption('real')
  await expect.poll(() => state.analysis.performanceRequests.at(-1)?.get('session_type')).toBe('real')
  await page.keyboard.press('Escape')
  await expect(mode(page)).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-current', 'page')
})

test('nothing can be written from Stats: no export, no charges editor, no question manager', async ({ page }) => {
  const state = await openStats(page)
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await mode(page).selectOption('real')
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Actual Real charges' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await tab(page, 'Habits').click()
  await expect(page.getByRole('button', { name: 'Manage questions' })).toBeHidden()
  expect(state.requests.filter(r => r.path.startsWith('/api/desktop/') && r.method !== 'GET')).toHaveLength(0)
  expect(state.requests.filter(r => r.path.includes('real-fees'))).toHaveLength(0)
})

test('a trade opens its details over the pane; the back key closes them', async ({ page }) => {
  await openStats(page)
  await expect(page.getByRole('heading', { name: 'Trace the individual trades' })).toBeAttached()
  await page.getByRole('button', { name: 'Details →' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Trade cycle details' })
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText('NIFTY')
  const box = (await drawer.boundingBox())!
  expect(box.x).toBeGreaterThan(150)
  expect(box.x + box.width).toBeLessThanOrEqual(915)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-current', 'page')
})

test.describe('Habits', () => {
  test('the scorecard ranks the habits and the sections switch', async ({ page }) => {
    const state = await openStats(page)
    await tab(page, 'Habits').click()
    await expect(page.getByRole('heading', { name: 'Which habit costs or earns the most' })).toBeVisible()
    await expect(page.locator('.hb-table')).toContainText('Chased the move')
    await expect(page.locator('.hb-table')).toContainText('Waited for confirmation')
    expect(state.requests.some(r => r.path === '/api/desktop/v1/analysis/behavior/habit-ledger')).toBe(true)
    const sections = page.getByRole('navigation', { name: 'Habits sections' })
    await sections.getByRole('button', { name: 'Deep dive' }).click()
    await expect(page.getByRole('heading', { name: 'Habit deep dive' })).toBeVisible()
    await sections.getByRole('button', { name: 'Trends across sessions' }).click()
    await expect(page.locator('.hb svg').first()).toBeVisible()
  })

  test('an older server without the behavior routes says so and offers retry', async ({ page }) => {
    await openStats(page, state => { state.analysis.habitsOld = true })
    await tab(page, 'Habits').click()
    await expect(page.getByText('This feature is not available on this server.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  })
})

test('an older server without Stats says so instead of showing an error code', async ({ page }) => {
  await openStats(page, state => { state.analysis.stats = 'old' })
  await expect(page.getByRole('alert')).toContainText('This feature is not available on this server.')
  await expect(page.getByRole('alert')).not.toContainText('ApiError')
})

test('a failed load can be retried', async ({ page }) => {
  await openStats(page, state => { state.analysis.stats = 'fail-once' })
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.pa-kpi').first()).toContainText('₹1,950')
})

test('a range with no trades shows an empty Stats screen, not an error', async ({ page }) => {
  await openStats(page, state => { state.analysis.stats = 'empty' })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(/A clear view starts with your trades|No loaded cycles match/).first()).toBeVisible()
})

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('the tab strip, KPI row and Filters button fit without sideways page scroll', async ({ page }) => {
      await openStats(page)
      await expect(page.locator('.pa-kpi').first()).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      for (const name of ['Overview', 'Entries', 'Exits', 'Sizing', 'Behavior', 'Habits']) {
        const box = (await tab(page, name).boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(40)
      }
      const filters = (await page.getByRole('button', { name: 'Filters', exact: true }).boundingBox())!
      expect(filters.height).toBeGreaterThanOrEqual(44)
      expect(filters.y + filters.height).toBeLessThanOrEqual(viewport.height)
      // The first KPI tile is on screen without scrolling: the numbers come first.
      const kpi = (await page.locator('.pa-kpi').first().boundingBox())!
      expect(kpi.y + kpi.height).toBeLessThanOrEqual(viewport.height)
    })

    test('the filters panel fits the screen and scrolls inside itself', async ({ page }) => {
      await openStats(page)
      await page.getByRole('button', { name: 'Filters', exact: true }).click()
      const panel = (await page.locator('.pa-overlay > .pa-filters').boundingBox())!
      expect(panel.y).toBeGreaterThanOrEqual(0)
      expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height)
      expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width)
    })
  })
}
