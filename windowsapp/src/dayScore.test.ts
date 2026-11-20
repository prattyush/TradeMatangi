import { describe, expect, it } from 'vitest'
import { createDayScoreSource } from '../../shared/analysis/dayScore/source'
import { badgeFor, itemsByImpact, pendingText, scoreBand, scoreByDate, signedPoints, trustNote } from '../../shared/analysis/dayScore/model'
import type { ScoreItem } from '../../shared/analysis/dayScore/types'
import { summarize } from '../../shared/analysis/habits/habitStats'
import { kindLabel, type LedgerQuestion, type LedgerTrade } from '../../shared/analysis/habits/types'

describe('day score model', () => {
  it('bands 75 and above good, 50 to 74 fair, below 50 poor', () => {
    expect([100, 75, 74, 50, 49, 0].map(scoreBand)).toEqual(['good', 'good', 'fair', 'fair', 'poor', 'poor'])
  })

  it('writes points with a real minus sign and no plus on zero', () => {
    expect([15, -8, 0].map(signedPoints)).toEqual(['+15', '−8', '0'])
  })

  it('says how far a day is from a score', () => {
    expect(pendingText({ status: 'no_trades', closed: 0, labelled: 0 })).toMatch(/No closed trades/)
    expect(pendingText({ status: 'pending_labels', closed: 5, labelled: 3 })).toBe('Label the 2 closed trades that have no label (3 of 5 labelled) to get the day\'s score.')
    expect(pendingText({ status: 'pending_labels', closed: 4, labelled: 3 })).toMatch(/Label the last closed trade \(3 of 4 labelled\)/)
    expect(pendingText({ status: 'scored', closed: 3, labelled: 3 })).toBe('')
  })

  it('notes an estimated limit and partial candles, and nothing otherwise', () => {
    expect(trustNote({ limit_source: 'saved', limit_pct: 10, drawdown: { partial: false } as never })).toBeNull()
    expect(trustNote({ limit_source: 'estimated', limit_pct: 12, drawdown: { partial: false } as never })).toMatch(/estimated at 12%/)
    expect(trustNote({ limit_source: 'saved', limit_pct: 10, drawdown: { partial: true } as never })).toMatch(/candles were missing/)
    expect(trustNote({ limit_source: 'estimated', limit_pct: 12, drawdown: { partial: true } as never })).toMatch(/estimated.*; candles/)
  })

  it('builds the badge text and hover for a full score and for a stored row', () => {
    expect(badgeFor({ score: 78, limit_source: 'saved', drawdown: { partial: false } as never })).toEqual({ text: 'Score 78', title: 'Day score 78 of 100' })
    expect(badgeFor({ score: 41, limit_source: 'estimated', partial: true })).toEqual({ text: 'Score 41', title: 'Day score 41 of 100 (limit estimated, partial candles)' })
  })

  it('lists the costliest rule first and the bonuses last', () => {
    const item = (key: ScoreItem['key'], points: number): ScoreItem => ({ key, title: key, points, detail: '', count: null })
    expect(itemsByImpact([item('clean_day', 15), item('drawdown', -14), item('repeat_entry', 0), item('big_loss_wipes_gains', -22)]).map(i => i.key))
      .toEqual(['big_loss_wipes_gains', 'drawdown', 'repeat_entry', 'clean_day'])
  })

  it('maps stored rows by date', () => {
    expect(scoreByDate([{ date: '2026-11-16', score: 70, limit_source: 'saved', partial: false, computed_at: null }]).get('2026-11-16')).toBe(70)
  })
})

describe('day score source', () => {
  it('reads two exact read-only paths', async () => {
    const calls: Array<[string, string]> = []
    const source = createDayScoreSource(async (path, method) => { calls.push([path, method]); return {} as never })
    await source.day('2026-11-19')
    await source.range()
    await source.range('2026-11-01', '2026-11-30')
    await source.range('2026-11-01', undefined, true)
    expect(calls).toEqual([
      ['day-score?date=2026-11-19', 'GET'], ['day-scores', 'GET'], ['day-scores?start=2026-11-01&end=2026-11-30', 'GET'], ['day-scores?start=2026-11-01&compute=true', 'GET'],
    ])
  })
})

describe('system habits in the Habits screens', () => {
  const trade = (n: number, net_pnl: number, habits: string[]): LedgerTrade => ({
    cycle_id: `c${n}`, session_id: 's', date: '2026-11-16', entry_time: n, exit_time: n + 1, symbol: 'NIFTY', right: null, strike: null, direction: 'LONG', net_pnl, pnl_pct: net_pnl / 100,
    capital_pct: null, risk_pct: null, entries: 1, exits: 1, holding_seconds: 60, bars: 1, r_multiple: null, entry_method: null, habits,
  })
  const questions: LedgerQuestion[] = [
    { question_id: 'qa', kind: 'entry', text: 'Chased', status: 'active', sort_order: 0, created_at: '', archived_at: null },
    { question_id: 'sys:repeat_entry', kind: 'system', system: true, text: 'Re-entered and lost again', status: 'active', sort_order: -3, created_at: '', archived_at: null },
    { question_id: 'sys:add_to_loser', kind: 'system', system: true, text: 'Added to a loser', status: 'active', sort_order: -2, created_at: '', archived_at: null },
  ]
  const trades = [trade(1, -100, ['sys:repeat_entry']), trade(2, -50, ['qa', 'sys:repeat_entry']), trade(3, 80, [])]

  it('counts a system habit like any other and shows it under the System filter only', () => {
    const all = summarize(questions, trades)
    expect(all.habits.map(h => h.question_id).sort()).toEqual(['qa', 'sys:repeat_entry'])
    expect(all.habits.find(h => h.question_id === 'sys:repeat_entry')).toMatchObject({ kind: 'system', habit: { trades: 2, net_pnl: -150 }, baseline: { trades: 1, net_pnl: 80 } })
    expect(summarize(questions, trades, { kind: 'system' }).habits.map(h => h.question_id)).toEqual(['sys:repeat_entry'])
    expect(summarize(questions, trades, { kind: 'system' }).idle.map(q => q.question_id)).toEqual(['sys:add_to_loser'])
    expect(summarize(questions, trades, { kind: 'entry' }).habits.map(h => h.question_id)).toEqual(['qa'])
  })

  it('labels the kinds', () => {
    expect(['entry', 'exit', 'system'].map(k => kindLabel(k as never))).toEqual(['Entry', 'Exit', 'System'])
  })
})
