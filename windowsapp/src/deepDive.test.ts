import { describe, expect, it, vi } from 'vitest'
import { createDeepDiveClient } from '../../shared/deepdive/client'
import {
  activeTags, applyTagValues, blockFor, cycleDay, dayMarks, dayMarksByDate, defaultSideForTrade, diffDayMarks, findStats,
  formatDay, formatPct, gaps, isComplete, nextGapIndex, orderSetups, positionLabel, restNotValid, sideForRight, sortTagStats,
  stepIndex, successLine, tagLine, tagState, tagValueOf, thinNote, toggleTag, unmarkedDaysForTag, unmarkedTagIds, validateTagName,
} from '../../shared/deepdive/model'
import type { DeepDiveSetup, DeepDiveTag, StatsAllEntry, StatsBlock, TagStat } from '../../shared/deepdive/types'
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

  it('cycles one click through none, Buy, Sell, both and back', () => {
    let marks = { buy: false, sell: false }
    const seen = []
    for (let click = 0; click < 4; click += 1) { marks = cycleDay(marks); seen.push({ ...marks }) }
    expect(seen).toEqual([{ buy: true, sell: false }, { buy: false, sell: true }, { buy: true, sell: true }, { buy: false, sell: false }])
  })

  it('turns a change of marks into the saves it needs', () => {
    expect(diffDayMarks({ buy: true, sell: false }, { buy: false, sell: true })).toEqual({ add: ['sell'], remove: ['buy'] })
    expect(diffDayMarks({ buy: true, sell: true }, { buy: true, sell: true })).toEqual({ add: [], remove: [] })
  })

  it('maps trade side and option right', () => {
    expect(sideForRight('CE')).toBe('buy')
    expect(sideForRight('PE')).toBe('sell')
    expect(sideForRight('')).toBeNull()
    expect(defaultSideForTrade('PE')).toBe('sell')
    expect(defaultSideForTrade(undefined)).toBe('all')
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
