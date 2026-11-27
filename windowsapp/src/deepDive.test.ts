import { describe, expect, it, vi } from 'vitest'
import { createDeepDiveClient } from '../../shared/deepdive/client'
import {
  activeTags, applyTagValues, blockFor, computeGroupStats, groupCellLabel, shareLine, dayMarks, dayMarksByDate, defaultSideForTrade, findStats,
  formatDay, formatPct, gaps, isComplete, nextGapIndex, orderSetups, positionLabel, removalImpact, restNotValid, setupSideOfTrade, SIDE_MEANING, sortTagStats,
  stepIndex, successLine, tagLine, tagState, tagValueOf, thinNote, toggleTag, unmarkedDaysForTag, unmarkedTagIds, validateTagName,
} from '../../shared/deepdive/model'
import { comparableDives, dayKey, dayOptionLabel, daysNewestFirst, diveKey, legOrUnderlying, legsFor, sideLeg } from '../../shared/deepdive/ui/compareModel'
import type { DeepDiveSetup, DeepDiveTag, DiveSummary, StatsAllEntry, StatsBlock, TagStat } from '../../shared/deepdive/types'
import { createPatternsClient } from './patternsClient'
import { validPatternsPath } from './patternsApi'

const tag = (id: string, name = id, status: 'active' | 'archived' = 'active'): DeepDiveTag =>
  ({ tag_id: id, name, status, sort_order: 0, created_at: '', archived_at: null })

const setup = (date: string, side: 'buy' | 'sell', tag_values: Record<string, boolean> = {}, extra: Partial<DeepDiveSetup> = {}): DeepDiveSetup => ({
  category: 'Breakout', strategy: 'Opening range', symbol: 'NIFTY', date, side, strike_ce: null, strike_pe: null, strike_mode: null,
  interval_minutes: 3, annotations: [], outcome: null, tag_values, notes: '', created_at: '', updated_at: '', ...extra,
})

describe('ordering and calendar marks', () => {
  it('walks dates ascending with Buy before Sell', () => {
    const ordered = orderSetups([setup('2026-10-07', 'sell'), setup('2026-10-06', 'sell'), setup('2026-10-07', 'buy')])
    expect(ordered.map(s => `${s.date} ${s.side}`)).toEqual(['2026-10-06 sell', '2026-10-07 buy', '2026-10-07 sell'])
  })

  it('reads a day as none, Buy, Sell or both', () => {
    const list = [setup('2026-10-06', 'buy'), setup('2026-10-07', 'buy'), setup('2026-10-07', 'sell')]
    expect(dayMarks(list, '2026-10-06')).toEqual({ buy: true, sell: false })
    expect(dayMarks(list, '2026-10-07')).toEqual({ buy: true, sell: true })
    expect(dayMarks(list, '2026-10-08')).toEqual({ buy: false, sell: false })
    expect(dayMarks(list, '2026-10-06', 'BSESEN')).toEqual({ buy: false, sell: false })
    expect([...dayMarksByDate(list).keys()]).toEqual(['2026-10-06', '2026-10-07'])
  })

  it('says what un-marking a side would throw away', () => {
    expect(removalImpact(setup('2026-10-06', 'buy')).hasData).toBe(false)
    expect(removalImpact(setup('2026-10-06', 'buy', { t1: true, t2: false }, { outcome: 'failed', notes: '  ' }))).toEqual(
      { tagMarks: 2, chartMarks: 0, hasOutcome: true, hasNotes: false, hasData: true })
    expect(removalImpact(setup('2026-10-06', 'buy', {}, { notes: 'x' })).hasData).toBe(true)
  })

  it('puts a position on the side it profits from', () => {
    // equity or index: long is Buy, short is Sell
    expect(setupSideOfTrade({ action: 'BUY' })).toBe('buy')
    expect(setupSideOfTrade({ action: 'SELL' })).toBe('sell')
    expect(setupSideOfTrade({ right: null, action: 'buy' })).toBe('buy')
    // CE: bought is Buy, sold (short) is Sell
    expect(setupSideOfTrade({ right: 'CE', action: 'BUY' })).toBe('buy')
    expect(setupSideOfTrade({ right: 'CE', action: 'SELL' })).toBe('sell')
    // PE: bought is Sell (bearish), sold (short) is Buy (bullish)
    expect(setupSideOfTrade({ right: 'PE', action: 'BUY' })).toBe('sell')
    expect(setupSideOfTrade({ right: 'PE', action: 'SELL' })).toBe('buy')
    expect(setupSideOfTrade({ right: 'pe', action: 'sell' })).toBe('buy')
    // unknown stays unknown, and the label form then opens on All
    expect(setupSideOfTrade({ right: 'CE' })).toBeNull()
    expect(setupSideOfTrade({ action: 'HOLD' })).toBeNull()
    expect(defaultSideForTrade({ right: 'PE', action: 'BUY' })).toBe('sell')
    expect(defaultSideForTrade({ right: 'PE', action: 'SELL' })).toBe('buy')
    expect(defaultSideForTrade({})).toBe('all')
    expect(SIDE_MEANING).toMatch(/CE bought/)
  })
})

describe('tags and gaps', () => {
  const tags = [tag('t1', 'Second leg'), tag('t2', 'Double top'), tag('old', 'Retired', 'archived')]

  it('tells valid, not valid and unmarked apart', () => {
    const day = setup('2026-10-06', 'buy', { t1: true, t2: false })
    expect(tagState(day, 't1')).toBe('valid')
    expect(tagState(day, 't2')).toBe('not_valid')
    expect(tagState(day, 'old')).toBe('unmarked')
    expect([tagValueOf('valid'), tagValueOf('not_valid'), tagValueOf('unmarked')]).toEqual([true, false, null])
  })

  it('a second tap on the same state clears it', () => {
    expect(toggleTag('unmarked', 'valid')).toBe('valid')
    expect(toggleTag('valid', 'valid')).toBe('unmarked')
    expect(toggleTag('valid', 'not_valid')).toBe('not_valid')
  })

  it('counts only active tags as missing, so an archived tag never blocks a day', () => {
    const day = setup('2026-10-06', 'buy', { t1: true })
    expect(unmarkedTagIds(day, tags)).toEqual(['t2'])
    expect(isComplete(day, tags)).toBe(false)
    expect(isComplete(setup('2026-10-06', 'buy', { t1: true, t2: false }), tags)).toBe(true)
    expect(activeTags(tags).map(t => t.tag_id)).toEqual(['t1', 't2'])
  })

  it('"mark the rest not valid" only touches unmarked tags', () => {
    expect(restNotValid(setup('2026-10-06', 'buy', { t1: true }), tags)).toEqual({ t2: false })
    expect(restNotValid(setup('2026-10-06', 'buy', { t1: true, t2: true }), tags)).toEqual({})
  })

  it('applies tag values locally like the server does', () => {
    const day = setup('2026-10-06', 'buy', { t1: true })
    expect(applyTagValues(day, { t2: false, t1: null }).tag_values).toEqual({ t2: false })
    expect(day.tag_values).toEqual({ t1: true })
  })

  it('lists the days that need marking in walking order, with what a new tag leaves open', () => {
    const list = [setup('2026-10-08', 'buy', { t1: true }), setup('2026-10-06', 'buy', { t1: true, t2: true }), setup('2026-10-07', 'sell', {})]
    expect(gaps(list, tags).map(g => [g.date, g.side, g.missing])).toEqual([['2026-10-07', 'sell', 2], ['2026-10-08', 'buy', 1]])
    expect(unmarkedDaysForTag(list, 't2')).toBe(2)
  })

  it('finds the next incomplete day, wrapping, and -1 when all are marked', () => {
    const done = { t1: true, t2: true }
    const list = [setup('2026-10-06', 'buy', done), setup('2026-10-07', 'buy', {}), setup('2026-10-08', 'buy', done)]
    expect(nextGapIndex(list, tags, 0)).toBe(1)
    expect(nextGapIndex(list, tags, 1)).toBe(1)
    expect(nextGapIndex(list, tags, 2)).toBe(1)
    expect(nextGapIndex([list[0], list[2]], tags, 0)).toBe(-1)
  })

  it('validates tag names like the server', () => {
    expect(validateTagName('  ', tags)).toMatch(/empty/)
    expect(validateTagName('x'.repeat(141), tags)).toMatch(/at most/)
    expect(validateTagName('second   LEG', tags)).toMatch(/already exists/)
    expect(validateTagName('second leg', tags, 't1')).toBeNull()
    expect(validateTagName('Retired', tags)).toBeNull()
    expect(validateTagName('New tag', tags)).toBeNull()
  })
})

describe('walking the days', () => {
  it('clamps stepping to the list', () => {
    expect([stepIndex(0, -1, 5), stepIndex(4, 1, 5), stepIndex(2, 1, 5), stepIndex(0, 1, 0)]).toEqual([0, 4, 3, 0])
  })

  it('labels the position and dates without a time zone', () => {
    const list = [setup('2026-10-06', 'buy'), setup('2026-03-11', 'sell')]
    expect(positionLabel(1, list)).toBe('2 / 2 · 11 Mar 2026 · SELL')
    expect(positionLabel(0, [])).toBe('No days marked')
    expect(positionLabel(1, list, 2026)).toBe('2 / 2 · 11 Mar · SELL') // the year of this year is left out of the header
    expect(positionLabel(0, list, 2026)).toBe('1 / 2 · 6 Oct · BUY')
    expect(positionLabel(1, list, 2025)).toBe('2 / 2 · 11 Mar 2026 · SELL') // another year stays
    expect(formatDay('2026-12-01')).toBe('1 Dec 2026')
    expect(formatDay('garbage')).toBe('garbage')
  })
})

describe('percentages', () => {
  const row = (extra: Partial<TagStat>): TagStat => ({ tag_id: 't', name: 'Double top', valid: 0, not_valid: 0, marked: 0, pct: null, few_days: true, ...extra })

  it('writes percentages with their sample size', () => {
    expect(formatPct(70)).toBe('70%')
    expect(formatPct(66.7)).toBe('66.7%')
    expect(formatPct(null)).toBe('—')
    expect(tagLine(row({ pct: 70, marked: 14, valid: 10, not_valid: 4 }))).toBe('Double top: 70% (n=14)')
    expect(tagLine(row({}))).toBe('Double top: — (n=0)')
  })

  it('warns about thin samples at the same threshold as the server', () => {
    expect(thinNote(0)).toMatch(/Not marked/)
    expect(thinNote(1)).toBe('Only 1 day marked')
    expect(thinNote(4)).toBe('Only 4 days marked')
    expect(thinNote(5)).toBeNull()
  })

  it('sorts the most frequent first and unmarked tags last', () => {
    const sorted = sortTagStats([row({ name: 'c' }), row({ name: 'a', pct: 40, marked: 5 }), row({ name: 'b', pct: 90, marked: 2 }), row({ name: 'd', pct: 40, marked: 9 })])
    expect(sorted.map(r => r.name)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('describes the success rate and picks a side block', () => {
    const block = (extra: Partial<StatsBlock>): StatsBlock => ({ days: 0, buy_days: 0, sell_days: 0, tags: [], success: 0, failed: 0, with_outcome: 0, success_pct: null, outcome_few_days: true, ...extra })
    expect(successLine(block({ success: 8, failed: 4, with_outcome: 12, success_pct: 66.7 }))).toBe('Success 8 of 12 (66.7%)')
    expect(successLine(block({}))).toBe('No outcome marked yet')
    const entry: StatsAllEntry = { category: 'Breakout', strategy: 'Opening range', owner_id: 'u', shared: false, all: block({ days: 3 }), buy: block({ days: 2 }), sell: block({ days: 1 }) }
    expect(blockFor(entry, 'sell').days).toBe(1)
    expect(findStats([entry], 'Breakout', 'Opening range')).toBe(entry)
    expect(findStats([entry], 'Breakout', 'Other')).toBeNull()
    expect(findStats([{ ...entry, all: block({}) }], 'Breakout', 'Opening range')).toBeNull()
  })
})

describe('deep dive client', () => {
  const ref = { category: 'Breakout', strategy: 'Opening range' }
  const day = { ...ref, symbol: 'NIFTY', date: '2026-10-06', side: 'buy' as const }

  function recorder(reply: unknown = {}) {
    const request = vi.fn(async () => reply)
    return { request, api: createDeepDiveClient(request as never) }
  }

  it('builds every call the server routes expect', async () => {
    const { request, api } = recorder({ dives: [], status: 'deleted' })
    await api.listDives()
    await api.getDive(ref)
    await api.getDive(ref, 'owner-1')
    await api.getStats(ref, 'sell')
    await api.getStatsAll()
    await api.saveSetup(day, { outcome: 'success', strike_ce: null })
    await api.saveSetup(day)
    await api.deleteSetup(day)
    await api.setTagValues(day, { t1: true, t2: null })
    await api.saveToPatterns(day)
    await api.addTag(ref, 'Second leg')
    await api.updateTag(ref, 't1', 'Second leg?')
    await api.archiveTag(ref, 't1')
    await api.restoreTag(ref, 't1')
    expect(request.mock.calls).toEqual([
      ['deep-dive/dives', 'GET'],
      ['deep-dive/dive?category=Breakout&strategy=Opening+range', 'GET'],
      ['deep-dive/dive?category=Breakout&strategy=Opening+range&owner_id=owner-1', 'GET'],
      ['deep-dive/stats?category=Breakout&strategy=Opening+range&side=sell', 'GET'],
      ['deep-dive/stats/all', 'GET'],
      ['deep-dive/setup', 'PUT', { ...day, outcome: 'success', strike_ce: null }],
      ['deep-dive/setup', 'PUT', day],
      ['deep-dive/setup?category=Breakout&strategy=Opening+range&symbol=NIFTY&date=2026-10-06&side=buy', 'DELETE'],
      ['deep-dive/setup/tag-values', 'PUT', { ...day, tag_values: { t1: true, t2: null } }],
      ['deep-dive/setup/save-to-patterns', 'POST', day],
      ['deep-dive/tags', 'POST', { ...ref, name: 'Second leg' }],
      ['deep-dive/tags/t1/update', 'POST', { ...ref, name: 'Second leg?' }],
      ['deep-dive/tags/t1/archive', 'POST', ref],
      ['deep-dive/tags/t1/restore', 'POST', ref],
    ])
  })

  it('unwraps lists and reads the delete result', async () => {
    expect(await recorder({ dives: [{ strategy: 'x' }] }).api.listDives()).toEqual([{ strategy: 'x' }])
    expect(await recorder({ dives: [] }).api.getStatsAll()).toEqual([])
    expect(await recorder({ status: 'deleted' }).api.deleteSetup(day)).toBe(true)
    expect(await recorder({ status: 'not_found' }).api.deleteSetup(day)).toBe(false)
  })

  it('every path the client builds passes the desktop allowlist, and the desktop client uses the same paths', async () => {
    const seen: Array<[string, string]> = []
    const native = vi.fn(async (_command: string, args: Record<string, unknown>) => {
      seen.push([String(args.path), String(args.method)])
      return { dives: [], status: 'deleted' }
    })
    const { patternsRequest } = await import('./patternsApi')
    const desktop = createPatternsClient(patternsRequest('http://x', native)).deepDive
    await desktop.listDives()
    await desktop.getDive(ref, 'o')
    await desktop.getStats(ref)
    await desktop.getStatsAll()
    await desktop.saveSetup(day, { notes: 'n' })
    await desktop.deleteSetup(day)
    await desktop.setTagValues(day, { t1: false })
    await desktop.saveToPatterns(day)
    await desktop.addTag(ref, 'Tag')
    await desktop.updateTag(ref, 'abc-1', 'Tag 2')
    await desktop.archiveTag(ref, 'abc_1')
    await desktop.restoreTag(ref, 'abc1')
    expect(seen).toHaveLength(12)
    for (const [path, method] of seen) expect(validPatternsPath(path, method), `${method} ${path}`).toBe(true)
  })
})

describe('calendar', () => {
  it('builds Monday-first weeks that cover the month exactly', async () => {
    const { monthGrid } = await import('../../shared/deepdive/calendar')
    const october = monthGrid({ year: 2026, month: 10 }) // 1 Oct 2026 is a Thursday
    expect(october[0].map(c => c.day)).toEqual([28, 29, 30, 1, 2, 3, 4])
    expect(october[0].map(c => c.inMonth)).toEqual([false, false, false, true, true, true, true])
    expect(october.every(week => week.length === 7)).toBe(true)
    expect(october.flat().filter(c => c.inMonth)).toHaveLength(31)
    expect(october.at(-1)!.at(-1)!.date).toBe('2026-11-01')
    const february = monthGrid({ year: 2026, month: 2 }) // starts on a Sunday, 28 days
    expect(february).toHaveLength(5)
    expect(february[0].map(c => c.day)).toEqual([26, 27, 28, 29, 30, 31, 1])
  })

  it('shifts months across years and labels them', async () => {
    const { shiftMonth, monthLabel, monthOf } = await import('../../shared/deepdive/calendar')
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth({ year: 2026, month: 3 }, -14)).toEqual({ year: 2025, month: 1 })
    expect(monthLabel({ year: 2026, month: 10 })).toBe('October 2026')
    expect(monthOf('2026-03-11')).toEqual({ year: 2026, month: 3 })
  })

  it('allows weekdays before today only, and opens on the last weekday', async () => {
    const { pickableDay, lastPickableDay, isWeekend, todayIso } = await import('../../shared/deepdive/calendar')
    expect(pickableDay('2026-10-06', '2026-10-08')).toBe(true)
    expect(pickableDay('2026-10-08', '2026-10-08')).toBe(false) // today is not complete
    expect(pickableDay('2026-10-10', '2026-10-20')).toBe(false) // Saturday
    expect(isWeekend('2026-10-11')).toBe(true)
    expect(lastPickableDay('2026-10-12')).toBe('2026-10-09') // Monday -> Friday
    expect(lastPickableDay('2026-10-07')).toBe('2026-10-06')
    expect(todayIso(new Date(2026, 9, 5))).toBe('2026-10-05')
  })
})

describe('stats (mirror of the server)', () => {
  it('rounds one decimal with ties to even, like Python', async () => {
    const { roundTenth } = await import('../../shared/deepdive/model')
    expect([roundTenth(6.25), roundTenth(18.75), roundTenth(31.25), roundTenth(43.75), roundTenth(56.25)]).toEqual([6.2, 18.8, 31.2, 43.8, 56.2])
    expect([roundTenth(66.666666), roundTenth(12.5), roundTenth(33.3333), roundTenth(100), roundTenth(0)]).toEqual([66.7, 12.5, 33.3, 100, 0])
  })

  const tags = [tag('q1', 'Second leg'), tag('q2', 'Double top'), tag('q3', 'Retired', 'archived')]

  it('gives the numbers the server tests expect for the same days', async () => {
    const { computeStats } = await import('../../shared/deepdive/model')
    const days = [
      setup('2026-10-06', 'buy', { q1: true, q2: true }, { outcome: 'success' }), setup('2026-10-07', 'buy', { q1: true }, { outcome: 'failed' }),
      setup('2026-10-08', 'buy', { q1: false }), setup('2026-10-09', 'buy', { q1: true }, { outcome: 'success' }),
    ]
    const stats = computeStats(days, tags)
    const [q1, q2] = stats.tags
    expect([q1.valid, q1.not_valid, q1.marked, q1.pct, q1.few_days]).toEqual([3, 1, 4, 75, true])
    expect([q2.marked, q2.pct]).toEqual([1, 100])
    expect([stats.success, stats.failed, stats.with_outcome, stats.success_pct]).toEqual([2, 1, 3, 66.7])
    expect(stats.tags).toHaveLength(2) // the archived tag is left out
    expect([stats.days, stats.buy_days, stats.sell_days]).toEqual([4, 4, 0])
  })

  it('filters by side and has no percentage without marks', async () => {
    const { computeStats, tagDots } = await import('../../shared/deepdive/model')
    const days = [setup('2026-10-06', 'buy', { q1: true }), setup('2026-10-07', 'buy', { q1: true }), setup('2026-10-06', 'sell', { q1: false })]
    expect(computeStats(days, tags, 'buy').tags[0].pct).toBe(100)
    expect(computeStats(days, tags, 'sell').tags[0].pct).toBe(0)
    expect(computeStats(days, tags).tags[0].pct).toBe(66.7)
    const empty = computeStats([setup('2026-10-06', 'buy')], tags)
    expect([empty.tags[0].pct, empty.success_pct]).toEqual([null, null])
    expect(tagDots(days[0], tags)).toEqual([
      { tag_id: 'q1', name: 'Second leg', state: 'valid' }, { tag_id: 'q2', name: 'Double top', state: 'unmarked' }])
  })
})

describe('strength of a successful day and the times read from the marks', () => {
  const mark = (type: 'entry' | 'exit', clock: string, instrument = 'underlying', price = 100) => {
    const [h, m] = clock.split(':').map(Number)
    return { id: `${type}${clock}${instrument}`, time: 1_791_244_800 + h * 3600 + m * 60, price, type, instrument, strategy_name: 'Opening range', category: 'Breakout' }
  }

  it('counts graded successes, and an old success with no grade as not graded', async () => {
    const { computeStats, strengthLine, outcomeText } = await import('../../shared/deepdive/model')
    const days = [
      setup('2026-10-06', 'buy', {}, { outcome: 'success', strength: 'ideal' }),
      setup('2026-10-07', 'buy', {}, { outcome: 'success', strength: 'poor' }),
      setup('2026-10-08', 'sell', {}, { outcome: 'success' }), // marked before grades existed
      setup('2026-10-09', 'sell', {}, { outcome: 'failed', strength: 'ideal' }), // a stray grade on a failure never counts
      setup('2026-10-12', 'buy'),
    ]
    const stats = computeStats(days, [])
    expect([stats.success, stats.failed, stats.success_pct]).toEqual([3, 1, 75])
    expect(stats.strength).toEqual({ ideal: 1, average: 0, poor: 1, ungraded: 1 })
    expect(computeStats(days, [], 'sell').strength).toEqual({ ideal: 0, average: 0, poor: 0, ungraded: 1 })
    expect(strengthLine(stats)).toBe('Ideal 1 · Average 0 · Poor 1 · not graded 1')
    expect(strengthLine(computeStats([setup('2026-10-06', 'buy')], []))).toBe('')
    expect(strengthLine({})).toBe('') // an older server sends no grades
    expect(days.map(outcomeText)).toEqual(['Ideal', 'Poor', 'Success', 'Failed', null])
  })

  it('reads the earliest entry and the latest exit, the underlying first, like the server', async () => {
    const { setupTimings } = await import('../../shared/deepdive/model')
    const marks = [mark('exit', '11:30'), mark('entry', '09:45'), mark('entry', '09:51', 'CE', 150), mark('exit', '10:06', 'CE', 190), mark('entry', '10:15')]
    const t = setupTimings(marks)
    expect([t.entry?.clock, t.entry?.instrument, t.exit?.clock, t.exit?.price]).toEqual(['09:45', 'underlying', '11:30', 100])
    expect(t.marks.map(m => `${m.type} ${m.clock}`)).toEqual(['entry 09:45', 'entry 09:51', 'exit 10:06', 'entry 10:15', 'exit 11:30'])
    const option = setupTimings([mark('entry', '09:48', 'PE'), mark('exit', '10:00', 'PE')])
    expect([option.entry?.instrument, option.entry?.clock, option.exit?.clock]).toEqual(['PE', '09:48', '10:00'])
    expect(setupTimings([])).toEqual({ entry: null, exit: null, marks: [] })
  })
})

describe('group: two tags together', () => {
  // A = "second leg", B = "exhaustive bar". Days 6 and 7 each leave one tag unmarked.
  const A = { tag_id: 'a', name: 'Second leg' }, B = { tag_id: 'b', name: 'Exhaustive bar' }
  const days = [
    setup('2026-10-01', 'buy', { a: true, b: true }), setup('2026-10-02', 'buy', { a: true, b: true }), setup('2026-10-03', 'buy', { a: true, b: false }),
    setup('2026-10-04', 'sell', { a: false, b: true }), setup('2026-10-05', 'sell', { a: false, b: false }), setup('2026-10-06', 'sell', { a: false }),
    setup('2026-10-07', 'buy', { b: true }), setup('2026-10-08', 'buy', { a: true, b: true }),
  ]

  it('counts only days where both tags are marked, in four cells', () => {
    const stats = computeGroupStats(days, A, B)
    expect(stats.counted).toBe(6)
    expect(stats.not_counted).toBe(2)
    expect(stats.cells.both.map(d => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-08'])
    expect(stats.cells.a_only.map(d => d.date)).toEqual(['2026-10-03'])
    expect(stats.cells.b_only.map(d => d.date)).toEqual(['2026-10-04'])
    expect(stats.cells.neither.map(d => d.date)).toEqual(['2026-10-05'])
    expect(stats.counts.both).toEqual({ n: 3, of: 6, pct: 50, few_days: false })
    expect(stats.counts.a_only.pct).toBe(16.7)
  })

  it('works out the conditional rates by hand', () => {
    const stats = computeGroupStats(days, A, B)
    // A was valid on 4 counted days (1, 2, 3, 8); B was valid on 3 of them.
    expect(stats.b_given_a).toEqual({ n: 3, of: 4, pct: 75, few_days: true })
    // A was not valid on 2 counted days (4, 5); B was valid on 1.
    expect(stats.b_given_not_a).toEqual({ n: 1, of: 2, pct: 50, few_days: true })
    // B was valid on 4 counted days (1, 2, 4, 8); A was valid on 3 of them.
    expect(stats.a_given_b).toEqual({ n: 3, of: 4, pct: 75, few_days: true })
    expect(shareLine(stats.b_given_a)).toBe('75% (3 of 4)')
  })

  it('swapping A and B swaps the conditional rates and the one-sided cells', () => {
    const stats = computeGroupStats(days, B, A)
    expect(stats.b_given_a).toEqual(computeGroupStats(days, A, B).a_given_b)
    expect(stats.cells.a_only.map(d => d.date)).toEqual(['2026-10-04'])
  })

  it('filters by side', () => {
    const buy = computeGroupStats(days, A, B, 'buy')
    expect(buy.counted).toBe(4); expect(buy.not_counted).toBe(1)
    expect(buy.counts.both.n).toBe(3); expect(buy.counts.a_only.n).toBe(1)
    const sell = computeGroupStats(days, A, B, 'sell')
    expect(sell.counted).toBe(2); expect(sell.not_counted).toBe(1)
    expect(sell.b_given_a).toEqual({ n: 0, of: 0, pct: null, few_days: true })
    expect(shareLine(sell.b_given_a)).toBe('No days')
  })

  it('rounds like the other percentages (ties to even, one decimal)', () => {
    const many = Array.from({ length: 16 }, (_, i) => setup(`2026-11-${String(i + 1).padStart(2, '0')}`, 'buy', { a: true, b: i === 0 }))
    expect(computeGroupStats(many, A, B).counts.both.pct).toBe(6.2) // 1 of 16 = 6.25 -> 6.2, as the server rounds
  })

  it('reads a cell in plain words and handles no days', () => {
    expect(groupCellLabel('a_only', 'Second leg', 'Exhaustive bar')).toBe('Second leg valid, Exhaustive bar not valid')
    const none = computeGroupStats([], A, B)
    expect(none.counted).toBe(0); expect(none.counts.both.pct).toBeNull()
  })

  it('accepts the compact days the live popup receives (no symbol)', () => {
    const compact = [{ date: '2026-10-01', side: 'buy' as const, tag_values: { a: true, b: true } }]
    expect(computeGroupStats(compact, A, B).counts.both.n).toBe(1)
  })
})

describe('compare: what a pane offers', () => {
  const summary = (category: string, strategy: string, days: number, can_edit = true): DiveSummary => ({ category, strategy, owner_id: can_edit ? 'me' : 'other', can_edit, days, buy_days: days, sell_days: 0, tags: 0, incomplete_days: 0 })

  it('offers only strategies with marked days, in name order, own before shared', () => {
    const list = comparableDives([summary('Reversal', 'Trap', 2), summary('Breakout', 'ORB', 0), summary('Breakout', 'Retest', 1), summary('Breakout', 'Retest', 3, false)])
    expect(list.map(d => `${d.category}/${d.strategy}/${d.can_edit}`)).toEqual(['Breakout/Retest/true', 'Breakout/Retest/false', 'Reversal/Trap/true'])
    expect(comparableDives([summary('A', 'B', 0)])).toEqual([])
  })

  it('lists days newest first and keeps Buy before Sell on one date', () => {
    const days = daysNewestFirst([setup('2026-10-06', 'buy'), setup('2026-10-08', 'sell'), setup('2026-10-08', 'buy')])
    expect(days.map(d => `${d.date} ${d.side}`)).toEqual(['2026-10-08 sell', '2026-10-08 buy', '2026-10-06 buy'])
  })

  it('gives every Pattern symbol the CE and PE charts and falls back to the underlying otherwise', () => {
    expect(legsFor('NIFTY')).toEqual(['underlying', 'CE', 'PE'])
    expect(legsFor('NOTASYMBOL')).toEqual(['underlying'])
    expect(legOrUnderlying('CE', 'NIFTY')).toBe('CE')
    expect(legOrUnderlying('PE', 'NOTASYMBOL')).toBe('underlying')
  })

  it('keys a day and a deep dive uniquely and says which leg a side is traded on', () => {
    expect(dayKey(setup('2026-10-06', 'buy'))).toBe('2026-10-06|NIFTY|buy')
    expect(diveKey(summary('Breakout', 'ORB', 1))).toBe('me|Breakout|ORB')
    expect(sideLeg({ side: 'buy' })).toBe('CE'); expect(sideLeg({ side: 'sell' })).toBe('PE')
    expect(dayOptionLabel({ ...setup('2026-10-06', 'buy'), annotations: [] }, formatDay)).toBe('6 Oct 2026 · Buy · NIFTY · 0 marks')
  })
})
