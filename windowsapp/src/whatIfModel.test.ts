import { describe, expect, it } from 'vitest'
import type { PerformanceCycle } from '../../shared/analysis/performance'
import type { LabeledRoundTrip } from '../../shared/analysis/labeling/model'
import { computeCommission, inferBrokerage, inferDayBrokerage } from '../../shared/analysis/whatif/fees'
import {
  buildWhatIfTrips, dayBrokerage, evaluateDay, evaluateTrip, fromSavedEdits, legKey, summaryOf, toSavedEdits,
  type DayEdits, type TripEdits, type WhatIfFill, type WhatIfTrip,
} from '../../shared/analysis/whatif/whatIfModel'
import golden from './whatIfGolden.json'

interface GoldenCycle { net_pnl: number; fees: number; pnl_pct: number; peak_capital_pct: number; capital: number; executions: Array<{ trade_id: string; role: 'entry' | 'exit'; side: 'BUY' | 'SELL'; quantity: number; price: number; timestamp: number; commission: number }> }
const cases = golden as unknown as Array<{ name: string; brokerage: number; margin: number; capital: number; edits: Array<{ id: string; quantity: number; price: number | null }>; original: GoldenCycle; edited: GoldenCycle | null }>

const tripOf = (cycle: GoldenCycle, margin: number, sessionType = 'sim', key = 's1#1'): WhatIfTrip => ({
  key, sessionId: 's1', cycleId: 'c', roundTrip: 1, contract: 'CE 24500', direction: cycle.executions[0].side === 'BUY' ? 'LONG' : 'SHORT',
  capital: cycle.capital, marginRate: margin, netPnl: cycle.net_pnl, sessionType,
  fills: cycle.executions.map(e => ({ id: e.trade_id, role: e.role, side: e.side, time: e.timestamp, quantity: e.quantity, price: e.price, commission: e.commission })),
})
const editsOf = (trip: WhatIfTrip, list: Array<{ id: string; quantity: number; price: number | null }>): TripEdits => {
  const edits: TripEdits = new Map()
  for (const item of list) {
    const fill = trip.fills.find(f => f.id === item.id)!
    edits.set(legKey(fill), { price: item.price ?? fill.price, quantity: item.quantity })
  }
  return edits
}

describe('the charge formula matches the backend', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s: every recorded charge is what the formula gives', (_, c) => {
    for (const e of c.original.executions) expect(computeCommission(e.side, e.price, e.quantity, c.brokerage)).toBeCloseTo(e.commission, 3)
  })
  it.each(cases.map(c => [c.name, c] as const))('%s: the brokerage can be read back from the fills', (_, c) => {
    for (const e of c.original.executions) expect(inferBrokerage(e.side, e.price, e.quantity, e.commission)).toBeCloseTo(c.brokerage, 1)
    expect(inferDayBrokerage(c.original.executions.map(e => ({ side: e.side, price: e.price, quantity: e.quantity, commission: e.commission })))).toBeCloseTo(c.brokerage, 1)
  })
  it('falls back to the platform default when no fill can say, and ignores a charge below the statutory part', () => {
    expect(inferDayBrokerage([])).toBe(1)
    expect(inferBrokerage('BUY', 100, 10, 0)).toBeNull() // a broker figure lower than the statutory charges
    expect(inferBrokerage('BUY', 0, 10, 5)).toBeNull()
    expect(inferDayBrokerage([{ side: 'BUY', price: 100, quantity: 10, commission: 0 }])).toBe(1)
  })
})

describe('what-if against the backend\'s own FIFO and charges', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s: unedited it is the server\'s figure; edited it equals the backend run on the edited fills', (_, c) => {
    const trip = tripOf(c.original, c.margin)
    const plain = evaluateTrip(trip, undefined, c.brokerage)
    expect(plain.edited).toBe(false)
    expect(plain.pnl).toBe(c.original.net_pnl)
    expect(plain.delta).toBe(0)
    expect(plain.actualPeakCapitalPct).toBeCloseTo(c.original.peak_capital_pct, 3)
    expect(plain.actualPnlPct).toBeCloseTo(c.original.pnl_pct, 4)
    if (!c.edited) return
    const result = evaluateTrip(trip, editsOf(trip, c.edits), c.brokerage)
    expect(result.edited).toBe(c.edits.length > 0)
    expect(result.pnl).toBeCloseTo(c.edited.net_pnl, 2)
    expect(result.pnlPct).toBeCloseTo(c.edited.pnl_pct, 4)
    expect(result.peakCapitalPct).toBeCloseTo(c.edited.peak_capital_pct, 3)
    expect(result.warnings).toEqual([])
    expect(result.delta).toBeCloseTo(c.edited.net_pnl - c.original.net_pnl, 2)
  })
})

describe('edits', () => {
  const sample = cases[0]
  const trip = tripOf(sample.original, sample.margin)
  const fill = (id: string) => trip.fills.find(f => f.id === id)!

  it('a leg changed by price shows its new capital % and the change; a removed leg costs nothing', () => {
    const result = evaluateTrip(trip, editsOf(trip, [{ id: '2', quantity: 0, price: null }, { id: '3', quantity: 75, price: 130 }]), 1)
    const second = result.legs.find(leg => leg.fill.id === '2')!
    expect(second).toMatchObject({ removed: true, changed: true, fee: 0, capitalPct: 0 })
    expect(second.originalCapitalPct).toBeCloseTo(8.25, 2) // 75 x 110 / 100000
    const exit = result.legs.find(leg => leg.fill.id === '3')!
    expect(exit.capitalPct).toBeCloseTo(9.75, 2) // 75 x 130 / 100000
    expect(exit.originalCapitalPct).toBeCloseTo(18.75, 2)
  })

  it('unmatched quantity warns and the P&L is the uneven cash flow', () => {
    const result = evaluateTrip(trip, editsOf(trip, [{ id: '3', quantity: 100, price: null }]), 1)
    expect(result.entryQuantity).toBe(150)
    expect(result.exitQuantity).toBe(100)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/150.*100.*uneven/)
    expect(result.pnl).toBeLessThan(0) // 50 units bought and never sold
  })

  it('removing everything says so, and an extra buy with no sell shows a negative result', () => {
    const none = evaluateTrip(trip, editsOf(trip, trip.fills.map(f => ({ id: f.id, quantity: 0, price: null }))), 1)
    expect(none.warnings[0]).toMatch(/removed/)
    expect(none.pnl).toBeCloseTo(0, 1) // nothing traded: nothing made, nothing paid
    expect(none.delta).toBeCloseTo(-trip.netPnl, 1)
    const extra = evaluateTrip(tripOf(cases[5].original, 1), editsOf(tripOf(cases[5].original, 1), [{ id: '1', quantity: 150, price: null }]), 1)
    expect(extra.warnings[0]).toMatch(/uneven/)
    expect(extra.pnl).toBeLessThan(-5000)
  })

  it('invalid typed values are ignored: the real price and quantity stay', () => {
    const edits: TripEdits = new Map([[legKey(fill('3')), { price: Number.NaN, quantity: Number.NaN }], [legKey(fill('1')), { price: -5, quantity: 75.4 }]])
    const result = evaluateTrip(trip, edits, 1)
    expect(result.legs.find(l => l.fill.id === '3')).toMatchObject({ price: 125, quantity: 150, changed: false })
    expect(result.legs.find(l => l.fill.id === '1')).toMatchObject({ price: 120, quantity: 75, changed: false })
    expect(result.edited).toBe(false)
  })

  it('a real session\'s charges are the broker\'s: scaled by traded value, not recomputed', () => {
    const real = { ...trip, sessionType: 'real' }
    const result = evaluateTrip(real, editsOf(real, [{ id: '3', quantity: 150, price: 250 }]), 1) // exit price doubled
    const exit = result.legs.find(l => l.fill.id === '3')!
    expect(exit.fee).toBeCloseTo(fill('3').commission * 2, 6)
  })

  it('peak capital follows the open lots at cost, first in first out', () => {
    const t: WhatIfTrip = { ...trip, marginRate: 1, capital: 1000, fills: [
      { id: 'a', role: 'entry', side: 'BUY', time: 1, quantity: 10, price: 10, commission: 0 },
      { id: 'b', role: 'entry', side: 'BUY', time: 2, quantity: 10, price: 20, commission: 0 },
      { id: 'c', role: 'exit', side: 'SELL', time: 3, quantity: 10, price: 30, commission: 0 },
      { id: 'd', role: 'entry', side: 'BUY', time: 4, quantity: 5, price: 40, commission: 0 },
      { id: 'e', role: 'exit', side: 'SELL', time: 5, quantity: 15, price: 30, commission: 0 },
    ] }
    // after a: 100; after b: 300; c closes a at cost; after d: 200 + 200 = 400; the rest closes.
    expect(evaluateTrip(t, undefined, 1).actualPeakCapitalPct).toBeCloseTo(40, 6)
  })
})

describe('the day', () => {
  const a = tripOf(cases[0].original, 1, 'sim', 's1#1')
  const b = { ...tripOf(cases[2].original, 1, 'sim', 's1#2'), roundTrip: 2 }
  const trips = [a, b]
  const capitals = new Map([['s1', 100000]])

  it('adds the trades up, actual against what-if, and counts the edited ones', () => {
    const edits: DayEdits = new Map([[a.key, editsOf(a, cases[0].edits)]])
    const { day, results } = evaluateDay(trips, edits, capitals, 1)
    expect(day.actual).toBeCloseTo(cases[0].original.net_pnl + cases[2].original.net_pnl, 1)
    expect(day.delta).toBeCloseTo(cases[0].edited!.net_pnl - cases[0].original.net_pnl, 1)
    expect(day.whatif).toBeCloseTo(day.actual + day.delta, 1)
    expect(day.tripsEdited).toBe(1)
    expect(day.warnings).toBe(0)
    expect(day.deltaPct).toBeCloseTo(day.delta / 1000, 3) // capital 100000
    expect(results.get(b.key)!.edited).toBe(false)
  })
  it('a day with no edits is exactly the actual day', () => {
    const { day } = evaluateDay(trips, new Map(), capitals, 1)
    expect(day.delta).toBe(0)
    expect(day.whatif).toBe(day.actual)
    expect(day.tripsEdited).toBe(0)
  })
  it('without the session capital the percentages are unknown, not zero', () => {
    const { day } = evaluateDay(trips, new Map(), new Map(), 1)
    expect(day).toMatchObject({ capital: null, actualPct: null, whatifPct: null, deltaPct: null })
  })
  it('counts the trades that carry a warning and turns the day into the summary that is saved', () => {
    const edits: DayEdits = new Map([[b.key, editsOf(b, [{ id: '3', quantity: 10, price: null }])]])
    const { day } = evaluateDay(trips, edits, capitals, 1)
    expect(day.warnings).toBe(1)
    expect(summaryOf(day)).toEqual({ actual_pnl: day.actual, whatif_pnl: day.whatif, delta: day.delta, delta_pct: expect.any(Number), trips_edited: 1, warnings: 1 })
    expect(summaryOf(evaluateDay(trips, new Map(), new Map(), 1).day).delta_pct).toBeNull()
  })
})

describe('saving and loading edits', () => {
  const a = tripOf(cases[0].original, 1, 'sim', 's1#1')
  const b = { ...tripOf(cases[2].original, 1, 'sim', 's2#2'), sessionId: 's2', roundTrip: 2 }
  const trips = [a, b]
  it('saves only the legs that really changed, per session, and loads them back', () => {
    const edits: DayEdits = new Map([[a.key, new Map([
      [legKey(a.fills[0]), { price: 120, quantity: 75 }], // same as the real fill: not saved
      [legKey(a.fills[1]), { price: 110, quantity: 0 }],
      [legKey(a.fills[2]), { price: 130, quantity: 75 }],
    ])], [b.key, editsOf(b, [{ id: '3', quantity: 60, price: 60 }])]])
    const saved = toSavedEdits(trips, edits, 's1')
    expect(saved).toEqual([
      { round_trip: 1, leg_id: '2', role: 'entry', price: 110, quantity: 0 },
      { round_trip: 1, leg_id: '3', role: 'exit', price: 130, quantity: 75 },
    ])
    expect(toSavedEdits(trips, edits, 's2')).toHaveLength(1)
    const loaded = fromSavedEdits(trips, saved, 's1')
    expect(loaded.missing).toBe(0)
    expect(loaded.edits.get(a.key)!.get('exit:3')).toEqual({ price: 130, quantity: 75 })
    expect(evaluateTrip(a, loaded.edits.get(a.key), 1).pnl).toBeCloseTo(cases[0].edited!.net_pnl, 2)
  })
  it('edits for a leg that is not in the day any more are counted, not applied', () => {
    const loaded = fromSavedEdits(trips, [{ round_trip: 9, leg_id: 'x', role: 'exit', price: 1, quantity: 1 }, { round_trip: 1, leg_id: '3', role: 'entry', price: 1, quantity: 1 }], 's1')
    expect(loaded.missing).toBe(2)
    expect(loaded.edits.size).toBe(0)
  })
})

describe('buildWhatIfTrips', () => {
  const cycle = (patch: Record<string, unknown>) => ({
    user_id: 'u', session_id: 's1', cycle_id: 'c1', symbol: 'NIFTY', right: 'CE', strike: 24500, direction: 'long', state: 'closed', net_pnl: 100, capital: 50000,
    entries: [{ analytics: { margin_rate: 0.2 } }], executions: [
      { execution_id: 'e1', trade_id: 't1', role: 'entry', side: 'BUY', quantity: 10, price: 100, timestamp: 1, commission: 2 },
      { trade_id: 't2', role: 'exit', side: 'SELL', quantity: 10, price: 110, timestamp: 2, commission: 3 },
    ], ...patch,
  }) as unknown as PerformanceCycle
  const trip = (cycleId: string | null, index = 1) => ({ session_id: 's1', index, cycle_id: cycleId, right: 'CE', entry_trades: [], exit_trades: [], pnl: 100 }) as unknown as LabeledRoundTrip
  it('builds a trip per completed round trip that has its cycle, with leg ids, margin and capital', () => {
    const [built] = buildWhatIfTrips([trip('c1')], [cycle({})], new Map([['s1', 'paper']]))
    expect(built).toMatchObject({ key: 's1#1', contract: 'CE 24500', direction: 'LONG', capital: 50000, marginRate: 0.2, netPnl: 100, sessionType: 'paper' })
    expect(built.fills.map((f: WhatIfFill) => [f.id, f.role, f.side])).toEqual([['e1', 'entry', 'BUY'], ['t2', 'exit', 'SELL']])
  })
  it('skips an open cycle, a round trip without a cycle, and one whose cycle is another session\'s', () => {
    expect(buildWhatIfTrips([trip('c1')], [cycle({ state: 'open' })], new Map())).toEqual([])
    expect(buildWhatIfTrips([trip(null)], [cycle({})], new Map())).toEqual([])
    expect(buildWhatIfTrips([trip('c1')], [cycle({ session_id: 'other' })], new Map())).toEqual([])
  })
  it('names an equity trade EQ and reads the brokerage from the paper fills only', () => {
    const built = buildWhatIfTrips([trip('c1'), trip('c2', 2)], [cycle({ right: null, strike: null }), cycle({ cycle_id: 'c2', session_id: 's1' })], new Map([['s1', 'sim']]))
    expect(built[0].contract).toBe('EQ')
    expect(dayBrokerage(built)).toBeGreaterThanOrEqual(0)
    const real = buildWhatIfTrips([trip('c1')], [cycle({})], new Map([['s1', 'real']]))
    expect(dayBrokerage(real)).toBe(1) // real charges say nothing about the platform's brokerage
  })
})
