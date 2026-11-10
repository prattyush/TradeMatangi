import { expect, test, type Page } from '@playwright/test'
import { mockServer, signIn, VIEWPORTS, type MockServer } from './fixtures'

const CHAPTERS = '0:00 Introduction\n0:35 Trade 1 · Breakout · +1.20%\n12:05 Trade 2 · Reversal · -0.40%'
const link = (session_id: string, video_id: string, title: string, privacy: string, uploaded_at: string, chapters = '') =>
  ({ session_id, video_id, title, privacy, url: `https://youtu.be/${video_id}`, chapters, uploaded_at })

function withVideos(state: MockServer) {
  state.analysis.videos = {
    's-0911-a': [
      link('s-0911-a', 'abcdefghijk', 'NIFTY 9 Nov review', 'unlisted', '2026-11-09T14:00:00Z', CHAPTERS),
      link('s-0911-a', 'privatevid1', 'Private practice', 'private', '2026-11-07T10:00:00Z'),
    ],
    's-0911-b': [link('s-0911-b', 'abcdefghijk', 'NIFTY 9 Nov review', 'unlisted', '2026-11-09T14:00:00Z', CHAPTERS)],
  }
}

/** Stand in for YouTube so no test touches the network; the iframe address is what the tests read. */
async function stubYoutube(page: Page) {
  await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body style="background:#123">player</body></html>' }))
}

async function openVideos(page: Page, setup?: (state: MockServer) => void) {
  await stubYoutube(page)
  const state = await mockServer(page)
  withVideos(state)
  setup?.(state)
  await signIn(page)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Videos' }).click()
  return state
}
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main' })

test('lists every saved video once, newest first, grouped by day', async ({ page }) => {
  const state = await openVideos(page)
  await expect(page.getByRole('button', { name: /^NIFTY 9 Nov review/ })).toHaveCount(1) // saved under two sessions, shown once
  await expect(page.getByRole('button', { name: /^Private practice/ })).toBeVisible()
  const titles = await page.locator('.video-row-title').allTextContents()
  expect(titles).toEqual(['NIFTY 9 Nov review', 'Private practice'])
  await expect(page.getByRole('group', { name: '9 Nov 2026' })).toBeVisible()
  await expect(page.getByRole('group', { name: '7 Nov 2026' })).toBeVisible()
  await expect(page.locator('.video-row').first()).toContainText('2 sessions')
  expect(state.requests.find(r => r.path === '/api/desktop/v1/analysis/video-links/mine')!.authorization).toBe('Bearer access-token-1')
})

test('an Unlisted video waits for Play, then plays; a chapter restarts it at that time; nothing loads before Play', async ({ page }) => {
  const youtube: string[] = []
  page.on('request', request => { if (request.url().includes('youtube')) youtube.push(request.url()) })
  await openVideos(page)
  await page.getByRole('button', { name: /^NIFTY 9 Nov review/ }).click()
  await expect(page.getByRole('heading', { name: 'NIFTY 9 Nov review' })).toBeVisible()
  await expect(page.locator('.video-side')).toContainText('Unlisted')
  await expect(page.locator('.video-side')).toContainText('NIFTY · 09 Nov') // the linked session, looked up by id
  expect(youtube).toHaveLength(0)
  await page.getByRole('button', { name: 'Play here' }).click()
  const frame = page.locator('iframe.video-frame')
  await expect(frame).toBeVisible()
  expect(new URL((await frame.getAttribute('src'))!).host).toBe('www.youtube-nocookie.com')
  expect(await frame.getAttribute('src')).not.toContain('start=')
  await page.getByRole('button', { name: '12:05 Trade 2 · Reversal · -0.40%' }).click()
  await expect(frame).toHaveAttribute('src', /start=725/)
  await expect(frame).toHaveAttribute('src', /autoplay=1/)
  await page.getByRole('button', { name: '0:35 Trade 1 · Breakout · +1.20%' }).click()
  await expect(frame).toHaveAttribute('src', /start=35/)
})

test('the player is sized by the pane height, 16:9, and never wider than its column', async ({ page }) => {
  await openVideos(page)
  await page.getByRole('button', { name: /^NIFTY 9 Nov review/ }).click()
  await page.getByRole('button', { name: 'Play here' }).click()
  const box = (await page.locator('iframe.video-frame').boundingBox())!
  const stage = (await page.locator('.video-stage').boundingBox())!
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02)
  expect(box.width).toBeLessThanOrEqual(stage.width + 1)
  expect(box.height).toBeLessThanOrEqual(stage.height + 1)
})

test('a Private video explains why it cannot play here and offers Open on YouTube', async ({ page }) => {
  await openVideos(page)
  await page.getByRole('button', { name: /^Private practice/ }).click()
  await expect(page.locator('.video-stage')).toContainText('Private on YouTube')
  await expect(page.getByRole('button', { name: 'Play here' })).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByText('No chapters were saved with this video.')).toBeVisible()
  const opened = page.waitForEvent('popup')
  await page.locator('.video-stage').getByRole('button', { name: 'Open on YouTube' }).click()
  expect((await opened).url()).toContain('privatevid1')
})

test('Back, "← Videos" and tapping Videos again all return to the list', async ({ page }) => {
  await openVideos(page)
  const row = page.getByRole('button', { name: /^NIFTY 9 Nov review/ })
  await row.click()
  await page.keyboard.press('Escape') // Android back
  await expect(row).toBeVisible()
  await row.click()
  await page.getByRole('button', { name: '← Videos' }).click()
  await expect(row).toBeVisible()
  await row.click()
  await rail(page).getByRole('button', { name: 'Videos' }).click()
  await expect(row).toBeVisible()
})

test('leaving the tab and coming back finds the same video', async ({ page }) => {
  await openVideos(page)
  await page.getByRole('button', { name: /^NIFTY 9 Nov review/ }).click()
  await rail(page).getByRole('button', { name: 'Stats' }).click()
  await rail(page).getByRole('button', { name: 'Videos' }).click()
  await expect(page.getByRole('heading', { name: 'NIFTY 9 Nov review' })).toBeVisible()
})

test('no saved videos shows an empty state', async ({ page }) => {
  await openVideos(page, state => { state.analysis.videos = {} })
  await expect(page.getByText('No saved videos yet')).toBeVisible()
})

test('an older server without saved videos says so', async ({ page }) => {
  await openVideos(page, state => { state.analysis.videosOld = true })
  await expect(page.getByText('Videos is not available on this server')).toBeVisible()
})

test('Videos only reads: no request writes anything', async ({ page }) => {
  const state = await openVideos(page)
  await page.getByRole('button', { name: /^NIFTY 9 Nov review/ }).click()
  await page.getByRole('button', { name: 'Play here' }).click()
  expect(state.requests.filter(r => r.path.startsWith('/api/desktop/') && r.method !== 'GET')).toHaveLength(0)
})

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })
    test('list rows are tappable and the player screen fits without scrolling the page', async ({ page }) => {
      await openVideos(page)
      for (const row of await page.locator('.video-row').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await page.getByRole('button', { name: /^NIFTY 9 Nov review/ }).click()
      await page.getByRole('button', { name: 'Play here' }).click()
      const frame = (await page.locator('iframe.video-frame').boundingBox())!
      const stage = (await page.locator('.video-stage').boundingBox())!
      // The frame takes everything the stage allows in one direction (full height, or full width on the smallest screens).
      expect(Math.min(Math.abs(frame.height - stage.height), Math.abs(frame.width - stage.width))).toBeLessThan(2)
      expect(frame.height).toBeGreaterThanOrEqual(viewport.height * 0.68)
      expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      for (const chapter of await page.locator('.chapter-list button').all()) expect((await chapter.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      for (const name of ['← Videos', 'Open on YouTube', 'Copy link']) expect((await page.getByRole('button', { name }).first().boundingBox())!.height).toBeGreaterThanOrEqual(40)
    })
  })
}
