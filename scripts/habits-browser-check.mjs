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
  // Accessibility floor: every button has a name, every table a caption and column scopes.
  const a11y = async where => {
    const unnamed = await page.locator('.hb button').evaluateAll(buttons => buttons.filter(b => !(b.getAttribute('aria-label') || b.textContent.trim())).length)
    const uncaptioned = await page.locator('.hb table').evaluateAll(tables => tables.filter(t => !t.querySelector('caption')).length)
    const headerless = await page.locator('.hb table thead th:not([scope])').count()
    assert.deepEqual([unnamed, uncaptioned, headerless], [0, 0, 0], `accessibility floor in ${where}: unnamed buttons, tables without caption, headers without scope`)
  }
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

  await a11y('scorecard')
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
  await a11y('trends day list')
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
  await a11y('compare')
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


  // ── Single-habit deep dive ───────────────────────────────────────────────
  await page.getByRole('button', { name: 'Scorecard', exact: true }).click()
  await page.getByRole('button', { name: 'Deep dive: Chased the move' }).click()
  await page.getByRole('heading', { name: 'Habit deep dive' }).waitFor()
  assert.equal(await page.locator('.hb-deep select').inputValue() !== '', true)
  const qa = ledgerTrades.filter(t => t.habits.includes('qa'))
  const tile = async label => (await page.locator('.hb-tile', { has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }).locator('strong').textContent()).trim()
  assert.equal(await tile('Trades'), String(qa.length)); assert.equal(await tile('Days'), String(new Set(qa.map(t => t.date)).size))
  near(await tile('Net %'), want.qa.net_pct, 'deep dive net %')
  near(await tile('Avg capital %'), want.qa.avg_capital, 'deep dive capital %', 0.051)
  const bucketRows = async title => page.locator('section.hb-bucket', { has: page.getByRole('heading', { name: title }) }).locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.children].map(cell => cell.textContent.trim()).join('|')))
  // By bars held: independent grouping.
  const barsOf = b => b == null ? 'Unknown' : b <= 1 ? '1 bar' : b === 2 ? '2 bars' : b <= 5 ? '3–5 bars' : b <= 10 ? '6–10 bars' : 'Over 10 bars'
  const barCounts = new Map(); for (const t of qa) barCounts.set(barsOf(t.bars), (barCounts.get(barsOf(t.bars)) ?? 0) + 1)
  const barRows = await bucketRows('By bars held')
  for (const [label, count] of barCounts) assert.ok(barRows.some(r => r.startsWith(`${label}|${count}|`)), `bars bucket ${label}=${count} in ${barRows}`)
  assert.equal(barRows.length, barCounts.size)
  // By capital: terciles of ALL trades' capital % (independent quantile).
  const allCapital = ledgerTrades.map(t => t.capital_pct).filter(c => c != null).sort((a, b) => a - b)
  const q = f => { const pos = (allCapital.length - 1) * f, lo = Math.floor(pos), hi = Math.ceil(pos); return allCapital[lo] + (allCapital[hi] - allCapital[lo]) * (pos - lo) }
  const capitalRows = await bucketRows('By capital used')
  assert.ok(capitalRows[0].startsWith(`Smaller (up to ${q(1 / 3).toFixed(1)}%)|`), `capital edges in ${capitalRows[0]}`)
  const lowCount = qa.filter(t => t.capital_pct != null && t.capital_pct <= q(1 / 3)).length
  assert.equal(capitalRows[0].split('|')[1], String(lowCount), `smaller-capital trades in ${capitalRows[0]}`)
  // Time of day and weekday.
  const timeRows = await bucketRows('By time of day')
  assert.deepEqual(timeRows.map(r => r.split('|')[0]), ['09:00–09:30', '13:00–13:30'])
  assert.equal(timeRows[0].split('|')[1], String(qa.filter(t => new Date(t.entry_time * 1000).getUTCHours() === 9).length))
  const weekday = d => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${d}T00:00:00Z`).getUTCDay()]
  const days = [...new Set(qa.map(t => weekday(t.date)))]
  assert.equal((await bucketRows('By weekday')).length, days.length)
  // Quick losses: independent count.
  const losers = qa.filter(t => t.net_pnl < -0.005), known = losers.filter(t => t.bars != null), quick = known.filter(t => t.bars <= 1)
  await page.getByRole('heading', { name: 'Losses closed within one bar' }).waitFor()
  await a11y('deep dive')
  assert.match(await page.locator('.hb-quick p').textContent(), new RegExp(`${quick.length} of ${known.length} losing trades`))
  // Scatter: a dot per trade with a capital % and a result; Enter on a dot opens the trade.
  const dots = page.locator('svg circle.hb-dot')
  assert.equal(await dots.count(), qa.filter(t => t.capital_pct != null && t.pnl_pct != null).length)
  await dots.first().focus(); await page.keyboard.press('Enter')
  await page.getByRole('dialog', { name: 'Trade cycle details' }).waitFor()
  assert.ok(qa.some(t => detailCalls.at(-1).path.endsWith(t.cycle_id)), 'the scatter dot opens one of the habit trades')
  await page.getByRole('button', { name: 'Close trade details' }).click()
  // Trade list: newest first; sorting by result puts the biggest loss first; Open works.
  const tradeRows = page.locator('table.hb-trades tbody tr')
  assert.equal(await tradeRows.count(), qa.length)
  const newest = qa.reduce((a, t) => (t.entry_time > a.entry_time ? t : a))
  assert.ok((await tradeRows.first().locator('th').textContent()).startsWith(newest.date))
  await page.locator('table.hb-trades').getByRole('button', { name: /^P&L %/ }).click()
  assert.equal(await page.locator('table.hb-trades th[aria-sort="descending"]').count(), 1)
  await page.locator('table.hb-trades').getByRole('button', { name: /^P&L %/ }).click()   // ascending: the biggest loss first
  const worst = qa.reduce((a, t) => (t.pnl_pct < a.pnl_pct ? t : a))
  assert.ok((await tradeRows.first().locator('th').textContent()).startsWith(worst.date))
  await tradeRows.first().getByRole('button', { name: /^Open trade/ }).click()
  await page.getByRole('dialog', { name: 'Trade cycle details' }).waitFor(); await page.getByRole('button', { name: 'Close trade details' }).click()
  await page.screenshot({ path: artifacts + '/habits-deep-dive.png' })
  // Another habit, including the archived one, via the selector.
  await page.locator('.hb-deep select').selectOption({ label: 'Entry · Old revenge habit (archived)' })
  assert.equal(await tile('Trades'), String(ledgerTrades.filter(t => t.habits.includes('qd')).length))
  assert.equal(await page.locator('.hb-verdict.low_sample').count() >= 1, true)
  // Phone: no sideways page scroll, charts and tiles fit.
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll in the deep dive on a phone')
  await page.locator('.hb-deep select').selectOption({ label: 'Entry · Chased the move' })
  assert.ok((await page.locator('.hb-scatter svg').boundingBox()).width <= 390)
  await page.locator('.hb-scatter').scrollIntoViewIfNeeded(); await page.screenshot({ path: artifacts + '/habits-phone-deep-dive.png' })
  await page.setViewportSize({ width: 1280, height: 1000 }); await page.waitForTimeout(200)
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
