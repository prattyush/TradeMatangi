import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { chartSymbol, chronological, clock, dailyCandles, dailyGeometry, deckStep, money, noteParts, percent, stripTone, summaryQuery, totalsOf, tradeName, tone } from '../../shared/analysis/summary/summaryModel'
import { createDaySummarySource } from '../../shared/analysis/summary/source'
import { validAnalysisPath } from './analysisApi'

const totals = (net: number, trades = 1) => ({ trades, wins: net > 0 ? trades : 0, losses: net < 0 ? trades : 0, win_pct: null, net_pnl: net, pnl_pct: null, mean_pnl_pct: null, fees: 0 })
const day = (date: string, net = 100, extra: Record<string, unknown> = {}) => ({ date, symbols: [{ symbol: 'NIFTY' }, { symbol: 'BANKNIFTY' }], totals: totals(net), score: null, note: null, ...extra }) as any

describe('the Summary request', () => {
  it('sends only the filled Stats filters the route understands', () => {
    expect(summaryQuery({})).toBe('')
    expect(summaryQuery({ start_date: '2026-11-01', end_date: '', session_type: 'real', symbol: '', trading_style: 'swing', portfolio_id: 'x', client: 'desktop' }))
      .toBe('?start_date=2026-11-01&session_type=real&client=desktop')
  })
  it('reads the one route over any transport and keeps it on the desktop allowlist', async () => {
    const request = vi.fn(async () => ({ days: [], total_days: 0, truncated: false }))
    const source = createDaySummarySource(request as any)
    await source.days({ start_date: '2026-11-01', symbol: 'NIFTY' })
    expect(request).toHaveBeenCalledWith('day-summary?start_date=2026-11-01&symbol=NIFTY', 'GET')
    expect(validAnalysisPath('day-summary?start_date=2026-11-01&symbol=NIFTY', 'GET')).toBe(true)
  })
})

describe('wording', () => {
  it('writes money and percent with a real minus sign and the Indian grouping', () => {
    expect(money(-1234567.5)).toBe('−₹12,34,567.5')
    expect(money(null)).toBe('—')
    expect(percent(-0.125)).toBe('−0.13%')
    expect(percent(0.4)).toBe('0.40%')
  })
  it('tones a result by its sign, near zero is flat', () => {
    expect([tone(5), tone(-5), tone(0.001), tone(null)]).toEqual(['pos', 'neg', 'flat', 'flat'])
  })
  it('names a trade by its contract and direction, and a time by the market clock', () => {
    expect(tradeName({ symbol: 'NIFTY', strike: 24500, right: 'CE', direction: 'SHORT' } as any)).toBe('NIFTY 24500 CE · Short')
    expect(tradeName({ symbol: 'TATMOT', strike: null, right: null, direction: 'LONG' } as any)).toBe('TATMOT · Long')
    expect(clock(Date.parse('2026-10-16T09:17:30Z') / 1000)).toBe('09:17')
  })
  it('shows the note parts that were written, context first', () => {
    expect(noteParts(null)).toEqual([])
    expect(noteParts({ context: '  ', went_well: 'Patience', to_improve: '', specific_points: 'Gap day' } as any).map(p => [p.key, p.text])).toEqual([['went_well', 'Patience'], ['specific_points', 'Gap day']])
    expect(noteParts({ context: 'Trend day', went_well: 'Patience', to_improve: '', specific_points: '' } as any).map(p => p.key)).toEqual(['context', 'went_well'])
  })
})

describe('the deck', () => {
  it('goes through the days oldest to newest', () => {
    expect(chronological([day('2026-10-16'), day('2026-10-14'), day('2026-10-15')]).map(d => d.date)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16'])
  })
  it('moves one day on the arrow keys, to the ends on Home and End, and never leaves the deck', () => {
    expect(deckStep('ArrowLeft', 2, 5)).toBe(1)
    expect(deckStep('ArrowRight', 2, 5)).toBe(3)
    expect(deckStep('ArrowLeft', 0, 5)).toBe(0)
    expect(deckStep('ArrowRight', 4, 5)).toBe(4)
    expect(deckStep('Home', 3, 5)).toBe(0)
    expect(deckStep('End', 1, 5)).toBe(4)
    expect(deckStep('a', 1, 5)).toBeNull()
    expect(deckStep('ArrowLeft', 0, 0)).toBeNull()
  })
  it('keeps the symbol you were on when the day has it, otherwise the first in alphabetical order (the chart tabs\' order)', () => {
    expect(chartSymbol(day('d'), 'NIFTY')).toBe('NIFTY')
    expect(chartSymbol(day('d'), 'TATMOT')).toBe('BANKNIFTY')
    expect(chartSymbol(day('d'))).toBe('BANKNIFTY')
    expect(chartSymbol(day('d', 1, { symbols: [] }))).toBe('')
  })
  it('colours the strip by the score band, or by the sign of the P&L when there is no score', () => {
    expect(stripTone(day('d', 100, { score: { score: 80 } }))).toBe('good')
    expect(stripTone(day('d', 100, { score: { score: 60 } }))).toBe('fair')
    expect(stripTone(day('d', 100, { score: { score: 30 } }))).toBe('poor')
    expect(stripTone(day('d', -5))).toBe('neg')
    expect(stripTone(day('d', 5))).toBe('pos')
  })
  it('adds the days up for the headline', () => {
    expect(totalsOf([day('a', 100, { totals: totals(100, 2) }), day('b', -40, { totals: totals(-40, 3) }), day('c', 0)])).toEqual({ days: 3, trades: 6, net_pnl: 60, winning_days: 1, losing_days: 1 })
  })
})

describe('the daily chart', () => {
  const at = (iso: string, close: number) => ({ time: Date.parse(`${iso}T00:00:00Z`) / 1000, open: close - 2, high: close + 5, low: close - 5, close })
  it('keeps the candles up to the day, oldest first, at most the wanted number', () => {
    const raw = [at('2026-10-16', 110), at('2026-10-13', 100), at('2026-10-14', 104), at('2026-10-17', 120), at('2026-10-15', 108)]
    expect(dailyCandles(raw, '2026-10-16').map(c => c.close)).toEqual([100, 104, 108, 110])
    expect(dailyCandles(raw, '2026-10-16', 2).map(c => c.close)).toEqual([108, 110])
    expect(dailyCandles([{ time: 0, open: 1, high: 1, low: 1, close: 1 }, { time: 5, open: NaN, high: 1, low: 1, close: 1 }], '2026-10-16')).toEqual([])
  })
  it('fits the candles into the box and marks the day', () => {
    const candles = dailyCandles([at('2026-10-14', 100), at('2026-10-15', 120), at('2026-10-16', 110)], '2026-10-16')
    const { bars, low, high } = dailyGeometry(candles, '2026-10-16', 100, 50, 0)
    expect([low, high]).toEqual([95, 125])
    expect(bars.map(b => b.highlighted)).toEqual([false, false, true])
    expect(bars.map(b => b.up)).toEqual([true, true, true])
    expect(bars[1].wickTop).toBeCloseTo(0) // the highest high touches the top
    expect(bars[0].wickBottom).toBeCloseTo(50) // the lowest low touches the bottom
    expect(dailyGeometry([], '2026-10-16', 100, 50).bars).toEqual([])
  })
})

describe('the hosts', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('the Windows app has a third Summary view, mounted when first opened, and the phone does not get the source', () => {
    const desktop = read('./DesktopAnalysis.tsx')
    expect(desktop).toContain("'Sessions' | 'Stats' | 'Summary'")
    expect(desktop).toContain('summaryVisited &&')
    expect(desktop).toContain('createDaySummarySource(notesRequest)')
    const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = `${dir}/${name}`; return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [] })
    const phone = sources(new URL('../../mobile/src', import.meta.url).pathname)
    expect(phone.length).toBeGreaterThan(10)
    expect(phone.filter(file => readFileSync(file, 'utf8').includes('daySummary'))).toEqual([])
  })
  it('the website offers the Summary beside Stats only when the host gives the source', () => {
    const page = read('../../shared/analysis/TradeAnalysis.tsx')
    expect(page).toContain('environment.daySummary && <button')
    expect(read('../../frontend/src/services/analysisEnvironment.tsx')).toContain("path.startsWith('day-summary')")
  })
})
