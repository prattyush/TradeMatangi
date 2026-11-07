import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisTrade, TradeLabel } from '../../shared/analysis/api'
import { LabelSaver } from '../../shared/analysis/labeling/saver'
import { blankLabel, contractName, finalizeLabel, isLabeled, orderRoundTrips, roundTripMarkerText, tradesForRoundTrip, type LabeledRoundTrip } from '../../shared/analysis/labeling/model'

const leg = (trade_id: string, side: 'BUY' | 'SELL', extra: Record<string, unknown> = {}) => ({ trade_id, side, quantity: 65, price: 100, timestamp: 1, ...extra })
const trip = (session_id: string, index: number, entry: string[], exit: string[], right: string | null = null, strike?: number): LabeledRoundTrip => ({
  session_id, index, right, pnl: 10,
  entry_trades: entry.map(id => leg(id, 'BUY', { strike })), exit_trades: exit.map(id => leg(id, 'SELL', { strike })),
})
const trade = (session_id: string, trade_id: string, extra: Partial<AnalysisTrade> = {}) => ({ session_id, trade_id, side: 'BUY', ...extra }) as AnalysisTrade

describe('round trip model', () => {
  it('defaults actual pattern and tags like the explicit Save did', () => {
    expect(finalizeLabel({ ...blankLabel('s', 1), expected_category: 'Trend', expected_strategy: 'ORB' })).toMatchObject({
      actual_category: 'Trend', actual_strategy: 'ORB', entry_tag: 'AS_PER_PATTERN', exit_tag: 'AS_PER_PATTERN',
    })
    expect(finalizeLabel({ ...blankLabel('s', 1), actual_strategy: 'Fade', exit_tag: 'EARLY' })).toMatchObject({ actual_strategy: 'Fade', exit_tag: 'EARLY', entry_tag: 'AS_PER_PATTERN' })
  })
  it('counts a trade as labeled only when a pattern value is chosen', () => {
    expect(isLabeled(undefined)).toBe(false)
    expect(isLabeled({ ...blankLabel('s', 0), entry_tag: 'X' })).toBe(false)
    expect(isLabeled({ ...blankLabel('s', 0), actual_strategy: 'ORB' })).toBe(true)
  })
  it('selects only the executions of one round trip within its own session', () => {
    const all = [
      trade('a', '1'), trade('a', '2'), trade('a', '3'), trade('b', '1'),
      trade('a', 'row-9', { execution_id: 'exec-3' }), trade('a', 'x', { stored_trade_id: '2' }),
    ]
    const rt = trip('a', 4, ['1'], ['2', 'exec-3'])
    expect(tradesForRoundTrip(rt, all).map(t => `${t.session_id}:${t.trade_id}`)).toEqual(['a:1', 'a:2', 'a:row-9', 'a:x'])
  })
  it('numbers markers by round trip, including a fill shared by two trips', () => {
    const first = trip('a', 1, ['1'], ['2'])
    const second = trip('a', 2, ['2'], ['3'])
    expect(roundTripMarkerText([first, second], trade('a', '1'))).toBe('#1 BUY')
    expect(roundTripMarkerText([first, second], trade('a', '2', { side: 'SELL' }))).toBe('#1/#2 SELL')
    expect(roundTripMarkerText([first, second], trade('a', '99'))).toBe('BUY')
  })
  it('names the contract from the legs', () => {
    expect(contractName(trip('a', 0, ['1'], ['2']))).toBe('EQ')
    expect(contractName(trip('a', 0, ['1'], ['2'], 'CE', 24500))).toBe('CE 24500')
    expect(contractName(trip('a', 0, ['1'], ['2'], 'PE'))).toBe('PE')
  })
  it('orders by session as given, then round trip index', () => {
    const rows = [trip('b', 0, [], []), trip('a', 2, [], []), trip('a', 1, [], []), trip('b', 1, [], [])]
    expect(orderRoundTrips(rows, ['a', 'b']).map(r => `${r.session_id}${r.index}`)).toEqual(['a1', 'a2', 'b0', 'b1'])
  })
})

describe('LabelSaver', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const label = (index: number, extra: Partial<TradeLabel> = {}): TradeLabel => ({ ...blankLabel('s', index), ...extra })

  it('saves only edited labels, after the debounce, with defaults applied', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = new LabelSaver(save, () => undefined, 500)
    saver.edit(label(1, { expected_strategy: 'ORB' }))
    saver.edit(label(1, { expected_strategy: 'ORB', expected_category: 'Trend' }))
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual([expect.objectContaining({ round_trip_index: 1, expected_category: 'Trend', actual_strategy: 'ORB', entry_tag: 'AS_PER_PATTERN' })])
    expect(saver.snapshot()).toMatchObject({ pending: 0, saving: false, error: '', savedCount: 1 })
  })
  it('flush saves immediately and a flush with nothing pending does not call the API', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = new LabelSaver(save)
    await expect(saver.flush()).resolves.toBe(true)
    expect(save).not.toHaveBeenCalled()
    saver.edit(label(2, { actual_strategy: 'Fade' }))
    await expect(saver.flush()).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1) // the debounce timer was cancelled by the flush
  })
  it('keeps unsaved edits and reports the error when a save fails, then retries them', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const saver = new LabelSaver(save)
    saver.edit(label(3, { expected_strategy: 'ORB' }))
    await expect(saver.flush()).resolves.toBe(false)
    expect(saver.snapshot()).toMatchObject({ pending: 1, saving: false, error: 'offline' })
    await expect(saver.flush()).resolves.toBe(true)
    expect(saver.snapshot()).toMatchObject({ pending: 0, error: '' })
    expect(save).toHaveBeenCalledTimes(2)
  })
  it('never overlaps saves and sends an edit made during a save in the next pass', async () => {
    let release!: () => void
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
      .mockResolvedValue(undefined)
    const saver = new LabelSaver(save)
    saver.edit(label(1, { expected_strategy: 'A' }))
    const first = saver.flush()
    saver.edit(label(1, { expected_strategy: 'B' })) // typed while the first save is in flight
    const second = saver.flush()
    expect(save).toHaveBeenCalledTimes(1)
    release()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0][0]).toMatchObject({ expected_strategy: 'B' })
    expect(saver.snapshot().pending).toBe(0)
  })
  it('reset forgets unsaved edits and cancels the timer', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = new LabelSaver(save)
    saver.edit(label(1, { expected_strategy: 'A' }))
    saver.reset()
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).not.toHaveBeenCalled()
    expect(saver.snapshot().pending).toBe(0)
  })
})
