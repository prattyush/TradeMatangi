/** Stats → Habits (Sprint 7b): scorecard, diverging chart, controls, coverage and phone layout on a multi-day ledger. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { ledger, expected, trades as ledgerTrades } from './habits-ledger-fixture.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const artifacts = root + '/.cache/habits-validation'
await mkdir(artifacts, { recursive: true })
const fixturePath = join(artifacts, 'overview-fixture.json')
execFileSync(process.env.PYTHON_BIN || 'python3', [root + '/scripts/phase20-browser-fixture.py', fixturePath], { env: { ...process.env, PYTHONPATH: root + '/backend' } })
const overview = JSON.parse(await readFile(fixturePath, 'utf8'))
const dir = await mkdtemp(join(tmpdir(), 'habits-ui-'))
await build({
  stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Dashboard from '${root}/frontend/src/components/PerformanceDashboard.tsx';
createRoot(document.getElementById('root')).render(<React.StrictMode><Dashboard onClose={()=>{}} defaultSymbol="" defaultStartDate="2026-09-01" defaultEndDate="2026-09-30" defaultInstrumentType="" defaultSessionType=""/></React.StrictMode>)`, resolveDir: root + '/frontend', loader: 'tsx' },
  alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, nodePaths: [root + '/frontend/node_modules'],
  jsx: 'automatic', bundle: true, outfile: dir + '/app.js', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
})
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [], ledgerCalls = [], detailCalls = []
  page.on('pageerror', error => errors.push(String(error)))
  let ledgerBody = ledger
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/behavior/habit-ledger')) { ledgerCalls.push(Object.fromEntries(url.searchParams)); return route.fulfill({ json: ledgerBody }) }
    if (path.endsWith('/behavior/questions')) return route.fulfill({ json: { questions: ledgerBody.questions } })
    if (path.endsWith('/analysis/performance')) return route.fulfill({ json: overview.report })
    if (path.endsWith('/analysis/performance/cycles')) return route.fulfill({ json: { items: overview.cycles, total: overview.cycles.length, next_offset: null } })
    if (path.includes('/analysis/performance/cycles/')) { detailCalls.push({ path, ...Object.fromEntries(url.searchParams) }); return route.fulfill({ json: overview.cycles[0] }) }
    return route.fulfill({ json: {} })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: 'Habits', exact: true }).click()
  const want = expected()
  const scorecard = page.locator('table.hb-table')
  await scorecard.waitFor()
  assert.deepEqual(ledgerCalls[0].start_date, '2026-09-01', 'the dashboard filters are sent to the ledger')

  // Rows are listed most destructive first (lowest net %), with the independent expectation for each habit.
  const order = Object.entries(want).sort((a, b) => a[1].net_pct - b[1].net_pct).map(([id]) => id)
  const names = { qa: 'Chased the move', qb: 'Exited after one bar in profit', qc: 'Waited for the retest', qd: 'Old revenge habit' }
  const rowNames = async () => (await scorecard.locator('tbody th .hb-name').allTextContents())
  assert.deepEqual(await rowNames(), order.map(id => names[id]))
  const cell = async (name, column) => {
    const headers = await scorecard.locator('thead th').allTextContents()
    const index = headers.findIndex(text => text.replace(/[▲▼]/g, '').trim().startsWith(column))
    assert.ok(index >= 0, `column ${column} in ${headers}`)
    const rows = scorecard.locator('tbody tr', { has: page.locator('.hb-name', { hasText: name }) })
    return (await rows.first().locator('th, td').nth(index).textContent()).trim()
  }
  const num = text => Number(text.replace('−', '-').replace(/[%+₹,]/g, ''))
  const near = (text, value, what, tolerance = 0.011) => assert.ok(Math.abs(num(text) - value) <= tolerance, `${what}: shown ${text}, expected ${value.toFixed(3)}`)  // half-cent rounding boundaries
  for (const id of order) {
    near(await cell(names[id], 'Net %'), want[id].net_pct, `${id} net %`)
    near(await cell(names[id], 'Loss %'), want[id].loss_pct, `${id} loss %`)
    assert.equal(await cell(names[id], 'Trades'), String(want[id].trades))
  }
  near(await cell(names.qc, 'Profit %'), want.qc.profit_pct, 'qc profit %')
  // Verdicts: chased costs, waiting for the retest pays, the archived habit has too few trades.
  const verdict = async name => scorecard.locator('tbody tr', { has: page.locator('.hb-name', { hasText: name }) }).locator('.hb-verdict').textContent()
  assert.equal(await verdict(names.qa), 'Costly'); assert.equal(await verdict(names.qc), 'Rewarding'); assert.equal(await verdict(names.qd), 'Low sample')
  assert.match(await scorecard.locator('.hb-verdict.costly').first().getAttribute('title'), /Net −[\d.]+% over \d+ trades/)
  assert.ok(await scorecard.locator('tr.archived').count() === 1 && await scorecard.getByText('Archived', { exact: true }).count() === 1)

  // Chart: one focusable row per habit, labelled with its numbers.
  const bars = page.locator('svg.hb-diverging g[role="img"]')
  assert.equal(await bars.count(), order.length)
  assert.match(await bars.first().getAttribute('aria-label'), /Chased the move|Exited after/)
  // Coverage and idle habits.
  await page.getByText(/closed trades · \d+ habit marks on \d+ trades/).waitFor()
  await page.getByText('2 marks not matched to a trade').waitFor(); await page.getByText('1 marked trade still open').waitFor()
  await page.getByText(/Not marked on any trade in this period: Moved the stoploss out/).waitFor()
  await page.getByText(/Habits with fewer than 10 trades/).waitFor()
  await page.screenshot({ path: artifacts + '/habits-scorecard.png', fullPage: true })

  // Controls: unit, average, type, archived, columns, sorting.
  await page.getByRole('group', { name: 'Unit' }).getByRole('button', { name: '₹' }).click()
  near(await cell(names.qa, 'Net ₹'), want.qa.net_pnl, 'qa net ₹')
  await page.getByRole('group', { name: 'Unit' }).getByRole('button', { name: '% of capital' }).click()
  await page.getByRole('group', { name: 'Average' }).getByRole('button', { name: 'Median' }).click()
  await scorecard.getByRole('button', { name: /Median % \/ trade/ }).waitFor()
  await page.getByRole('group', { name: 'Average' }).getByRole('button', { name: 'Mean' }).click()
  await page.getByRole('group', { name: 'Habit type' }).getByRole('button', { name: 'Exit' }).click()
  assert.deepEqual(await rowNames(), [names.qb]); await page.getByText(/Not marked on any trade in this period: Moved the stoploss out/).waitFor()
  await page.getByRole('group', { name: 'Habit type' }).getByRole('button', { name: 'All' }).click()
  await page.getByLabel('Include archived').uncheck(); assert.equal((await rowNames()).includes(names.qd), false); await page.getByLabel('Include archived').check()
  await page.getByRole('button', { name: /^Trades/ }).click()
  assert.equal(await scorecard.locator('th[aria-sort="descending"]').count(), 1)
  assert.equal((await rowNames())[0].length > 0, true)
  await page.getByRole('group', { name: 'Columns' }).getByRole('button', { name: 'Size & timing' }).click()
  await scorecard.getByRole('button', { name: /Max capital %/ }).waitFor()
  assert.equal(await scorecard.getByRole('button', { name: /Verdict/ }).count(), 0)
  const expectedAvgCapital = want.qa.avg_capital
  near(await cell(names.qa, 'Avg capital %'), expectedAvgCapital, 'qa average capital % (shown to 1 decimal)', 0.051)
  assert.match(await cell(names.qa, '≤ 1 bar'), /^\d+%$/)
  await page.screenshot({ path: artifacts + '/habits-size-timing.png', fullPage: true })
  await page.getByRole('group', { name: 'Columns' }).getByRole('button', { name: 'Results' }).click()


  // ── Trends across days ───────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Trends across days', exact: true }).click()
  const chart = page.locator('.hb-chart'); await chart.waitFor()
  const readout = page.locator('.hb-readout')
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length
  const dayKeys = [...new Set(ledgerTrades.map(t => t.date))].sort()
  const habitDay = (id, day) => ledgerTrades.filter(t => t.habits.includes(id) && t.date === day)
  assert.match(await chart.locator('svg').getAttribute('aria-label'), /^Net \(% of capital\) per trading day for /)
  assert.equal(await page.getByRole('group', { name: 'Habits shown' }).getByRole('button').count(), 4, 'a chip per habit')
  assert.equal(await page.getByRole('group', { name: 'Habits shown' }).locator('[aria-pressed="true"]').count(), 4)
  // Capital %: a line per habit; the chased habit is taken with less capital as the days go on.
  await page.getByLabel('Metric').selectOption('capital')
  await chart.focus(); await page.keyboard.press('Home')
  const firstDay = dayKeys[0], lastDay = dayKeys[dayKeys.length - 1]
  await page.waitForFunction(() => document.querySelector('.hb-readout strong')?.textContent === '14 Sep')
  const pctOf = n => `${n.toFixed(1)}%`
  assert.match(await readout.textContent(), new RegExp(`Chased the move: ${pctOf(mean(habitDay('qa', firstDay).map(t => t.capital_pct)))}`))
  await page.keyboard.press('End')
  assert.match(await readout.textContent(), new RegExp(`Chased the move: ${pctOf(mean(habitDay('qa', lastDay).map(t => t.capital_pct)))}`))
  assert.ok(mean(habitDay('qa', firstDay).map(t => t.capital_pct)) > mean(habitDay('qa', lastDay).map(t => t.capital_pct)))
  // The archived habit stops after day 3: a gap (—), never 0, on later days.
  await chart.focus(); await page.keyboard.press('End')
  assert.match(await readout.textContent(), /Old revenge habit: —/)
  // Legend chips switch a habit's line off and on.
  const chips = page.getByRole('group', { name: 'Habits shown' })
  await chips.getByRole('button', { name: 'Exited after one bar in profit' }).click()
  assert.doesNotMatch(await readout.textContent(), /Exited after one bar/)
  await chips.getByRole('button', { name: 'Exited after one bar in profit' }).click()
  assert.match(await readout.textContent(), /Exited after one bar in profit: 10\.0%/)
  // Occurrences are counts: 0 (not a gap) on a day without the habit.
  await page.getByLabel('Metric').selectOption('occurrences')
  await chart.focus(); await page.keyboard.press('End')
  assert.match(await readout.textContent(), /Old revenge habit: 0/)
  await page.keyboard.press('Home')
  assert.match(await readout.textContent(), new RegExp(`Chased the move: ${habitDay('qa', firstDay).length}`))
  // Rolling average and unit change the chart description.
  await page.getByRole('checkbox', { name: '5-day average' }).check()
  assert.match(await chart.locator('svg').getAttribute('aria-label'), /5-day average/)
  await page.getByRole('checkbox', { name: '5-day average' }).uncheck()
  await page.getByLabel('Metric').selectOption('net')
  await page.getByRole('group', { name: 'Unit' }).getByRole('button', { name: '₹' }).click()
  assert.match(await chart.locator('svg').getAttribute('aria-label'), /\(₹\)/)
  await page.getByRole('group', { name: 'Unit' }).getByRole('button', { name: '% of capital' }).click()
  // Select a day: the trades carrying the shown habits, and open one in the cycle drawer.
  await chart.focus(); await page.keyboard.press('Home'); await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: `${firstDay}: trades carrying the shown habits` }).waitFor()
  const shown = ledgerTrades.filter(t => t.date === firstDay && t.habits.some(id => ['qa', 'qb', 'qc', 'qd'].includes(id)))
  assert.equal(await page.locator('.hb-day tbody tr').count(), shown.length)
  await page.locator('.hb-day tbody tr').first().getByRole('button', { name: /^Open trade/ }).click()
  await page.getByRole('dialog', { name: 'Trade cycle details' }).waitFor()
  assert.equal(detailCalls.at(-1).session_id, shown[0].session_id); assert.ok(detailCalls.at(-1).path.endsWith(shown[0].cycle_id))
  await page.getByRole('button', { name: 'Close trade details' }).click()
  await page.screenshot({ path: artifacts + '/habits-trends.png' })

  // ── Compare periods ──────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Compare periods', exact: true }).click()
  await page.getByText(/Needs more than 10 trading days of history/).waitFor()   // 10 days cannot be split 10 vs 10
  await page.getByRole('group', { name: 'Period length' }).getByRole('button', { name: 'Last 5 days vs before' }).click()
  const compare = page.locator('table.hb-compare'); await compare.waitFor()
  await page.getByText(/Before 2026-09-14/).waitFor()
  const compareRow = name => compare.locator('tbody tr', { has: page.locator('.hb-name', { hasText: name }) })
  const half = dayKeys.length / 2, beforeDays = dayKeys.slice(0, half), recentDays = dayKeys.slice(half)
  const perDay = (id, days) => ledgerTrades.filter(t => t.habits.includes(id) && days.includes(t.date)).length / days.length
  assert.equal(await compareRow('Chased the move').locator('.hb-flag').textContent(), 'Improving')
  assert.equal(await compareRow('Exited after one bar').locator('.hb-flag').textContent(), 'Same')
  assert.equal(await compareRow('Waited for the retest').locator('.hb-flag').textContent(), 'Same')
  assert.equal(await compareRow('Old revenge habit').locator('.hb-flag').textContent(), 'Too few trades')
  const chasedRow = (await compareRow('Chased the move').locator('td').allTextContents()).join(' | ')
  assert.ok(chasedRow.includes(`${perDay('qa', beforeDays).toFixed(2)} → ${perDay('qa', recentDays).toFixed(2)}`), `per-day cell in: ${chasedRow}`)
  const capitalOf = days => mean(ledgerTrades.filter(t => t.habits.includes('qa') && days.includes(t.date) && t.capital_pct != null).map(t => t.capital_pct))
  assert.ok(chasedRow.includes(`${capitalOf(beforeDays).toFixed(1)}% → ${capitalOf(recentDays).toFixed(1)}%`), `capital cell in: ${chasedRow}`)
  assert.equal(await compareRow('Chased the move').locator('.hb-delta.good').count() >= 2, true, 'net and loss changes are shown as better')
  assert.match(await compareRow('Chased the move').locator('.hb-flag').getAttribute('title'), /Loss per day improved/)
  // Days with vs without the habit.
  const dwTable = page.locator('table.hb-table').last()
  assert.equal(await dwTable.locator('tbody tr').count(), 4)
  // Custom ranges.
  await page.getByRole('group', { name: 'Period length' }).getByRole('button', { name: 'Custom' }).click()
  await page.getByLabel('Recent: from').waitFor()
  await page.getByLabel('Recent: from').fill(dayKeys[8]); await page.getByLabel('Recent: from').press('Tab')
  await page.getByText(new RegExp(`Recent ${dayKeys[8]} – ${dayKeys[9]} \\(2 days\\)`)).waitFor()
  const pressedStyle = await page.getByRole('group', { name: 'Period length' }).locator('[aria-pressed="true"]').evaluate(el => getComputedStyle(el).backgroundColor)
  assert.equal(pressedStyle, 'rgb(165, 180, 252)', 'a pressed segmented button keeps its highlight while hovered')
  await page.screenshot({ path: artifacts + '/habits-compare.png' })
  await page.getByRole('group', { name: 'Period length' }).getByRole('button', { name: 'Last 5 days vs before' }).click()
  await page.getByRole('button', { name: 'Scorecard', exact: true }).click(); await page.locator('table.hb-table').first().waitFor()

  // Manage questions opens the manager; closing it reloads the ledger.
  const callsBefore = ledgerCalls.length
  await page.getByRole('button', { name: 'Manage questions' }).click()
  const manager = page.getByRole('dialog', { name: 'Behavior questions' }); await manager.waitFor()
  await manager.getByRole('button', { name: 'Close' }).click(); await manager.waitFor({ state: 'detached' })
  assert.equal(ledgerCalls.length, callsBefore, 'closing without a change does not reload')
  // Empty states.
  ledgerBody = { questions: [], trades: ledger.trades.map(t => ({ ...t, habits: [] })), coverage: { ...ledger.coverage, marks: 0, marked_trades: 0 } }
  await page.getByRole('button', { name: 'Refresh' }).click()
  await page.getByText('Start with a habit to track').waitFor()
  ledgerBody = { ...ledgerBody, questions: ledger.questions }
  await page.getByRole('button', { name: 'Refresh' }).click()
  await page.getByText('No habit marks in this selection').waitFor()
  ledgerBody = ledger
  await page.getByRole('button', { name: 'Refresh' }).click(); await scorecard.waitFor()

  // Phone: the page does not scroll sideways, the table scrolls inside its wrapper, the habit column stays in view.
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll on a phone')
  const wrap = page.locator('.pa-table-wrap').first()
  assert.ok(await wrap.evaluate(el => el.scrollWidth > el.clientWidth), 'the table scrolls inside its wrapper')
  await wrap.evaluate(el => { el.scrollLeft = 400 })
  const sticky = await page.locator('tbody th.hb-sticky').first().boundingBox(), wrapBox = await wrap.boundingBox()
  assert.ok(sticky.x >= wrapBox.x - 1 && sticky.x <= wrapBox.x + 4, 'the habit column stays at the left edge')
  await page.screenshot({ path: artifacts + '/habits-phone.png', fullPage: true })
  for (const section of ['Trends across days', 'Compare periods']) {
    await page.getByRole('button', { name: section, exact: true }).click(); await page.waitForTimeout(250)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal page scroll in ${section} on a phone`)
  }
  await page.getByRole('button', { name: 'Compare periods', exact: true }).click()
  await page.getByRole('group', { name: 'Period length' }).getByRole('button', { name: 'Last 5 days vs before' }).click()
  await page.locator('table.hb-compare').waitFor()
  assert.ok(await page.locator('table.hb-compare').evaluate(el => el.closest('.pa-table-wrap').scrollWidth > el.closest('.pa-table-wrap').clientWidth), 'the comparison table scrolls inside its wrapper')
  await page.getByRole('button', { name: 'Trends across days', exact: true }).click()
  const chartBox = await page.locator('.hb-chart svg').boundingBox()
  assert.ok(chartBox.width <= 390 && chartBox.height >= 250, `the chart scales to the phone width: ${JSON.stringify(chartBox)}`)
  await page.locator('.hb-chart').scrollIntoViewIfNeeded()
  await page.screenshot({ path: artifacts + '/habits-phone-trends.png' })
  await page.getByRole('button', { name: 'Scorecard', exact: true }).click(); await page.locator('svg.hb-diverging').scrollIntoViewIfNeeded()
  await page.screenshot({ path: artifacts + '/habits-phone-chart.png' })
  assert.deepEqual(errors, [])
  console.log('Stats → Habits scorecard, chart, controls and phone layout passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
