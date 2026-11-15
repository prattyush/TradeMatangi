import { describe, expect, it } from 'vitest'
import type { PerformanceCycle } from '../../shared/analysis/performance'
import type { LabeledRoundTrip } from '../../shared/analysis/labeling/model'
import { entryMethodInfo, exitMethodInfo } from '../../shared/analysis/walkthrough/exitMethods'
import { buildWalkthrough, holdingText, signedMoney, signedPct } from '../../shared/analysis/walkthrough/walkthroughModel'

const cycle = (patch: Record<string, unknown>) => ({
  user_id: 'u1', session_id: 's1', symbol: 'NIFTY', right: 'CE', strike: 24500, expiry: '2026-11-13', direction: 'LONG', state: 'closed',
  entry_time: 1000, exit_time: 1600, entry_count: 1, exit_count: 1, net_pnl: 0, pnl_pct: 0, fees: 40, open_quantity: 0, capital: 500000,
  executions: [], entries: [], exits: [], matches: [], label: null, ...patch,
}) as unknown as PerformanceCycle

// A: long CE, averaged once, stopped out at a profit. B: short, closed by the take-profit strategy at a loss. C: closed in the same second as B.
const A = cycle({
  cycle_id: 'A', net_pnl: 1000, pnl_pct: 0.2, peak_capital_pct: 3.6, holding_seconds: 600, fee_source: 'estimated',
  entries: [
    { entry_id: 'e1', entry_method: 'MARKET', timestamp: 1000, quantity: 75, average_price: 120, sizing_method: 'CAPITAL', requested_pct: 2, r_multiple: 1.5, client: 'desktop',
      analytics: { effective_allocation_pct: 1.8, effective_risk_pct: 0.3, margin_rate: 1, capital: 500000, initial_stop: 100 } },
    { entry_id: 'e2', entry_method: 'LIMIT', timestamp: 1100, quantity: 75, average_price: 110, sizing_method: 'UNKNOWN', requested_pct: null, analytics: {} },
  ],
  exits: [{ exit_id: 'x1', exit_method: 'STOPLOSS', quantity: 150, price: 125, timestamp: 1600, analytics: {} }],
})
const B = cycle({
  cycle_id: 'B', direction: 'SHORT', right: 'PE', strike: 24400, net_pnl: -300, pnl_pct: -0.06, entry_time: 2000, exit_time: 3000, peak_capital_pct: 1.2,
  entries: [{ entry_id: 'e3', entry_method: 'LIMIT', timestamp: 2000, quantity: 75, average_price: 80, sizing_method: 'RISK', requested_pct: 0.5, analytics: { effective_allocation_pct: 1.2, margin_rate: 1 } }],
  exits: [{ exit_id: 'x2', exit_method: 'TargetProfit', quantity: 75, price: 84, timestamp: 3000, analytics: {} }],
})
const C = cycle({ cycle_id: 'C', net_pnl: 50, pnl_pct: 0.01, entry_time: 2500, exit_time: 3000, entries: [], exits: [] })

const trip = (cycleId: string | null, index: number, patch: Record<string, unknown> = {}) => ({
  session_id: 's1', index, cycle_id: cycleId, right: 'CE', entry_trades: [{ trade_id: `${cycleId}-in`, side: 'BUY', quantity: 75, price: 100, timestamp: 1000 }],
  exit_trades: [{ trade_id: `${cycleId}-out`, side: 'SELL', quantity: 75, price: 110, timestamp: 1600 }], pnl: 0, ...patch,
}) as unknown as LabeledRoundTrip
const capitals = new Map([['s1', 500000]])

describe('how an exit happened', () => {
  it('names order exits by side: sell stoploss, sell limit, sell target; buy versions for shorts', () => {
    expect(exitMethodInfo('STOPLOSS', 'SELL')).toMatchObject({ code: 'SS', tone: 'stop' })
    expect(exitMethodInfo('STOPLOSS', 'BUY')).toMatchObject({ code: 'BS' })
    expect(exitMethodInfo('LIMIT', 'SELL')).toMatchObject({ code: 'SL', tone: 'limit' })
    expect(exitMethodInfo('LIMIT', 'BUY')).toMatchObject({ code: 'BL' })
    expect(exitMethodInfo('TARGET', 'SELL')).toMatchObject({ code: 'ST', tone: 'target' })
  })
  it('names strategy exits, closes and anything unrecorded', () => {
    expect(exitMethodInfo('TargetProfit')).toMatchObject({ code: 'TP', tone: 'strategy' })
    expect(exitMethodInfo('UnderlyingTargetProfit').code).toBe('UTP')
    expect(exitMethodInfo('AggressiveStoploss')).toMatchObject({ code: 'AGS', tone: 'stop' })
    expect(exitMethodInfo('BreakEven').code).toBe('BE')
    expect(exitMethodInfo('LockProfit').code).toBe('LP')
    expect(exitMethodInfo('SESSION_CLOSE')).toMatchObject({ code: 'SC', tone: 'close' })
    expect(exitMethodInfo('EOD_CLOSE').code).toBe('EOD')
    expect(exitMethodInfo('MARKET').code).toBe('MKT')
    expect(exitMethodInfo(undefined).code).toBe('?')
    expect(exitMethodInfo('SomethingNew')).toMatchObject({ code: '?', tone: 'unknown' })
  })
  it('names entries by how the order was placed', () => {
    expect(entryMethodInfo('MARKET', 'BUY').code).toBe('MKT')
    expect(entryMethodInfo('LIMIT', 'BUY').code).toBe('BL')
    expect(entryMethodInfo('LIMIT', 'SELL').code).toBe('SL')
    expect(entryMethodInfo('AUTOSTOP', 'BUY').code).toBe('AS')
    expect(entryMethodInfo('AUTOSTOP_LIMIT', 'SELL').code).toBe('ASL')
    expect(entryMethodInfo(null).code).toBe('?')
  })
})

describe('buildWalkthrough', () => {
  const trips = [trip('A', 1, { pnl: 1000, pnl_pct: 0.2, max_capital_pct: 3.6 }), trip('B', 2, { pnl: -300, pnl_pct: -0.06 }), trip('C', 3, { pnl: 50 })]
  const result = buildWalkthrough(trips, [A, B, C], capitals)

  it('gives each entry its time, size, price, capital %, risk % and how it was placed', () => {
    const a = result.get('s1#1')!
    expect(a.entries).toHaveLength(2)
    expect(a.entries[0]).toMatchObject({ role: 'entry', side: 'BUY', time: 1000, quantity: 75, price: 120, capitalPct: 1.8, riskPct: 0.3 })
    expect(a.entries[0].method.code).toBe('MKT')
    expect(a.entries[1].method.code).toBe('BL')
    expect(a.entries[0].details).toEqual(expect.arrayContaining([['Sizing', 'capital 2%'], ['Initial stop', '100'], ['R multiple', '1.5']]))
  })
  it('works out an exit\'s capital % from its size and price, and names how it happened', () => {
    const a = result.get('s1#1')!
    expect(a.exits).toHaveLength(1)
    expect(a.exits[0]).toMatchObject({ role: 'exit', side: 'SELL', time: 1600, quantity: 150, price: 125, capitalPct: 3.75 }) // 150 x 125 / 500000
    expect(a.exits[0].method).toMatchObject({ code: 'SS', name: 'Sell stoploss' })
  })
  it('a short trade opens with a sell and closes with a buy; its take-profit strategy exit is TP', () => {
    const b = result.get('s1#2')!
    expect(b.direction).toBe('SHORT')
    expect(b.entries[0]).toMatchObject({ side: 'SELL' })
    expect(b.exits[0]).toMatchObject({ side: 'BUY' })
    expect(b.exits[0].method.code).toBe('TP')
  })
  it('reports peak capital, P&L, charges, holding time and the charge source', () => {
    const a = result.get('s1#1')!
    expect(a).toMatchObject({ peakCapitalPct: 3.6, pnl: 1000, pnlPct: 0.2, fees: 40, feeSource: 'estimated', holdingSeconds: 600, detailed: true, contract: 'CE 24500' })
  })
  it('shows the day\'s realised P&L before and after each trade, in the order the trades closed', () => {
    const a = result.get('s1#1')!
    expect(a.before).toEqual({ pnl: 0, pnlPct: 0 })
    expect(a.after).toEqual({ pnl: 1000, pnlPct: 0.2 })
    expect(a.sameSecond).toBe(false)
  })
  it('trades that closed in the same second are walked one after the other and flagged', () => {
    const b = result.get('s1#2')!, c = result.get('s1#3')!
    expect(b.sameSecond).toBe(true)
    expect(c.sameSecond).toBe(true)
    expect(b.before).toEqual({ pnl: 1000, pnlPct: 0.2 })
    expect(b.after).toEqual({ pnl: 700, pnlPct: 0.14 })
    expect(c.before).toEqual(b.after) // the next one starts where the previous ended
    expect(c.after).toEqual({ pnl: 750, pnlPct: 0.15 })
  })
  it('without the capital the figures stay in money and the percent is unknown, not zero', () => {
    const noCapital = buildWalkthrough([trip('A', 1, { pnl: 1000 })], [A], new Map())
    expect(noCapital.get('s1#1')!.after).toEqual({ pnl: 1000, pnlPct: null })
  })
  it('falls back to the round trip\'s own legs when the server sent no cycle (older server)', () => {
    const old = buildWalkthrough([trip(null, 1, { pnl: 1000, max_capital_pct: 2.5, pnl_pct: 0.2 })], [], capitals).get('s1#1')!
    expect(old.detailed).toBe(false)
    expect(old.entries[0]).toMatchObject({ quantity: 75, price: 100, capitalPct: null, riskPct: null })
    expect(old.exits[0].method.code).toBe('?')
    expect(old).toMatchObject({ before: null, after: null, fees: null, peakCapitalPct: 2.5, pnlPct: 0.2, holdingSeconds: 600, direction: 'LONG' })
  })
  it('a cycle that is not in the day\'s list (another session) is not mixed in', () => {
    const other = buildWalkthrough([trip('A', 1)], [{ ...A, session_id: 'other' } as PerformanceCycle], capitals).get('s1#1')!
    expect(other.detailed).toBe(false)
  })
  it('works out an entry\'s capital % itself when the server did not send it', () => {
    const noAlloc = cycle({ cycle_id: 'D', entries: [{ entry_id: 'e9', entry_method: 'MARKET', timestamp: 1000, quantity: 100, average_price: 200, sizing_method: 'QUANTITY', analytics: { margin_rate: 0.2 } }], exits: [] })
    const walk = buildWalkthrough([trip('D', 1)], [noAlloc], capitals).get('s1#1')!
    expect(walk.entries[0].capitalPct).toBe(0.8) // 100 x 200 x 0.2 / 500000
  })
})

describe('text helpers', () => {
  it('formats the holding time', () => {
    expect(holdingText(40)).toBe('40s')
    expect(holdingText(750)).toBe('12m 30s')
    expect(holdingText(3900)).toBe('1h 05m')
    expect(holdingText(null)).toBe('—')
    expect(holdingText(-5)).toBe('—')
  })
  it('formats signed money and percent', () => {
    expect(signedMoney(1240.5)).toBe('+₹1,240.50')
    expect(signedMoney(-300)).toBe('−₹300.00')
    expect(signedMoney(null)).toBe('—')
    expect(signedPct(0.254)).toBe('+0.25%')
    expect(signedPct(-0.06)).toBe('−0.06%')
    expect(signedPct(undefined)).toBe('—')
  })
})

describe('order of the walkthrough', () => {
  const t = (sessionId: string, index: number, entries: number[], exits: number[]) => ({
    session_id: sessionId, index, right: null, pnl: 0,
    entry_trades: entries.map((timestamp, i) => ({ trade_id: `${sessionId}${index}e${i}`, side: 'BUY', quantity: 1, price: 1, timestamp })),
    exit_trades: exits.map((timestamp, i) => ({ trade_id: `${sessionId}${index}x${i}`, side: 'SELL', quantity: 1, price: 1, timestamp })),
  }) as unknown as LabeledRoundTrip
  it('goes by first entry, so overlapping trades come in the order they were opened, not closed', async () => {
    const { orderRoundTripsByEntry } = await import('../../shared/analysis/labeling/model')
    // 5 opens first but closes last; 3 opens second and closes first; 4 opens last.
    const trips = [t('s1', 3, [200], [300]), t('s1', 4, [400], [500]), t('s1', 5, [100], [600])]
    expect(orderRoundTripsByEntry(trips, ['s1']).map(trip => trip.index)).toEqual([5, 3, 4])
  })
  it('uses the earliest of several entries, and the number or the session only to break a tie', async () => {
    const { orderRoundTripsByEntry } = await import('../../shared/analysis/labeling/model')
    const trips = [t('s2', 1, [100], [150]), t('s1', 9, [300, 90], [400]), t('s1', 2, [100], [130])]
    expect(orderRoundTripsByEntry(trips, ['s1', 's2']).map(trip => `${trip.session_id}${trip.index}`)).toEqual(['s19', 's12', 's21'])
  })
  it('puts a trade with no timestamps last and keeps Label Trades\' own numbering order unchanged', async () => {
    const { orderRoundTripsByEntry, orderRoundTrips } = await import('../../shared/analysis/labeling/model')
    const trips = [t('s1', 1, [], []), t('s1', 0, [500], [600])]
    expect(orderRoundTripsByEntry(trips, ['s1']).map(trip => trip.index)).toEqual([0, 1])
    expect(orderRoundTrips([t('s1', 2, [100], []), t('s1', 1, [900], [])], ['s1']).map(trip => trip.index)).toEqual([1, 2])
  })
})
