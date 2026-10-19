import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPerformanceDiagnostics, recordFeedReceipt, beginPerformanceSample, endPerformanceSample } from '../../frontend/src/services/performanceDiagnostics'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function start(flag: string) {
  vi.useFakeTimers()
  const host: { tradingPerformance?: { entries: { name: string; eventId?: unknown }[] } } = {}
  vi.stubGlobal('window', host)
  vi.stubGlobal('localStorage', { getItem: () => flag })
  vi.stubGlobal('PerformanceObserver', undefined)
  const frame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', frame)
  return { host, frame, stop: startPerformanceDiagnostics() }
}

describe('opt-in feed measurements', () => {
  it('creates no observer/timer or feed work when disabled', () => {
    const { host, frame, stop } = start('0')
    recordFeedReceipt({ _feed_diagnostic: { event_id: 1, sent_at_ms: Date.now() } }, 'desktop:disabled')
    expect(host.tradingPerformance).toBeUndefined()
    expect(frame).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(beginPerformanceSample('disabled')).toBeUndefined()
    stop()
  })

  it('correlates once and deduplicates repeated native payloads', () => {
    const { host, frame, stop } = start('1')
    const event = { _feed_diagnostic: { event_id: 77, sent_at_ms: Date.now() } }
    recordFeedReceipt(event, 'desktop:sample')
    recordFeedReceipt(event, 'desktop:sample')
    expect(frame).toHaveBeenCalledTimes(1)
    expect(host.tradingPerformance!.entries.filter(row => row.name === 'feed-sample')).toEqual([expect.objectContaining({ eventId: 77 })])
    recordFeedReceipt({ type: 'tick' }, 'desktop:sample')
    expect(frame).toHaveBeenCalledTimes(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds storage and samples chart measurements', () => {
    const { host, stop } = start('1')
    for (let i = 0; i < 1000; i++) recordFeedReceipt({ _feed_diagnostic: { event_id: i, sent_at_ms: Date.now() } }, 'desktop:bounded')
    expect(host.tradingPerformance!.entries.length).toBeLessThanOrEqual(600)
    const sample = beginPerformanceSample('desktop-chart-update')
    expect(sample).toBeDefined()
    endPerformanceSample('desktop-chart-update', sample)
    expect(beginPerformanceSample('desktop-chart-update')).toBeUndefined()
    stop()
  })
})
