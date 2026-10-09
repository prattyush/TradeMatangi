/** Full website: candles and Settings remain usable while wallet reads wait. */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const artifacts = resolve(root, '.cache/wallet-chart-startup-fix')
await mkdir(artifacts, { recursive: true })
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html')
    res.end(await readFile(root + '/frontend/dist' + (path === '/' ? '/index.html' : path)))
  } catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
let releaseWallet
let walletGate = new Promise(resolve => { releaseWallet = resolve })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
  const errors = [], wallets = [], resets = []
  let balance = 150000
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => localStorage.setItem('auth_user', JSON.stringify({ userId: 'alice', email: 'alice@example.com', isAdmin: false, accountName: 'Alice' })))
  const candles = Array.from({ length: 200 }, (_, i) => ({ time: 1791447300 + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4, volume: 100 }))
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user_id: 'alice', email: 'alice@example.com', is_admin: false, account_name: 'Alice' } })
    if (path.endsWith('/groups/active')) return route.fulfill({ status: 204 })
    if (path.endsWith('/data/symbols')) return route.fulfill({ json: { symbols: [{ symbol: 'TATPOW', name: 'Tata Power' }, { symbol: 'NIFTY', name: 'NIFTY' }] } })
    if (path.endsWith('/data/available-dates')) return route.fulfill({ json: { dates: ['2026-10-08'] } })
    if (path.endsWith('/data/historical')) return route.fulfill({ json: { candles, symbol: 'TATPOW' } })
    if (path.endsWith('/wallet')) {
      wallets.push(url.searchParams.get('include_reset_status') === 'true')
      await walletGate
      return route.fulfill({ json: { user_id: 'alice', date: url.searchParams.get('date'), balance, ledger_kind: 'paper', reset_allowed: true } })
    }
    if (path.endsWith('/wallet/reset')) { resets.push(request.postDataJSON()); balance = resets.at(-1).amount; return route.fulfill({ json: { balance } }) }
    if (path.endsWith('/check-access')) return route.fulfill({ json: { has_access: false } })
    if (path.endsWith('/open-option-contracts')) return route.fulfill({ json: [] })
    await route.fulfill({ json: { settings: {}, candles: [], categories: [], strategies: [], emails: [], shared_from: [] } })
  })
  const waitForCandles = () => page.waitForFunction(() => Array.from(document.querySelectorAll('canvas')).some(canvas => {
    const context = canvas.getContext('2d'), pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data
    if (!pixels) return false
    let green = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 38 && pixels[i + 1] === 166 && pixels[i + 2] === 65) green++
    return green > 100
  }))
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' })
  await waitForCandles()
  assert(wallets.length > 0 && wallets.every(status => !status), 'Startup balance must not request reset scans')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const input = settings.getByPlaceholder('Custom amount')
  await input.fill('180000')
  assert.equal(await input.inputValue(), '180000')
  assert(wallets.includes(true), 'Settings must explicitly request reset eligibility')
  await page.screenshot({ path: artifacts + '/candles-settings-wallet-pending.png' })
  releaseWallet()
  await settings.getByRole('button', { name: 'Set', exact: true }).click()
  await page.waitForFunction(() => document.body.textContent.includes('Reset to ₹1,80,000'))
  assert.deepEqual(resets, [{ amount: 180000 }])
  walletGate = new Promise(resolve => { releaseWallet = resolve })
  const count = wallets.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForCandles()
  assert(wallets.slice(count).every(status => !status))
  releaseWallet()
  assert.deepEqual(errors, [])
  await writeFile(artifacts + '/browser-summary.json', JSON.stringify({ passed: true, checks: ['full App candles drawn during pending wallet read', 'Settings input editable during pending wallet read', 'toolbar skips reset scans', 'Settings requests reset checks', 'wallet reset submits entered amount', 'candles return after refresh', 'no page errors'] }, null, 2))
  console.log('Full website startup/candles/Settings browser acceptance passed')
} finally { releaseWallet?.(); await browser.close(); server.close() }
