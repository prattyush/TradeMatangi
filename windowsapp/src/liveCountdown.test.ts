import { describe, expect, it } from 'vitest'
import { formatCandleCloseCountdown, secondsUntilCandleClose } from './liveCountdown'

describe('live candle close countdown', () => {
  it('uses each chart interval independently', () => {
    // 09:24:10 is 10 seconds into both the 3-minute 09:24 candle and the
    // 15-minute 09:15 candle.
    const now = 9 * 3600 + 24 * 60 + 10
    expect(formatCandleCloseCountdown(now, 3)).toBe('02:50')
    expect(formatCandleCloseCountdown(now, 15)).toBe('05:50')
  })

  it('rolls over to a full new candle at the boundary', () => {
    expect(secondsUntilCandleClose(9 * 3600 + 27 * 60, 3)).toBe(180)
    expect(formatCandleCloseCountdown(9 * 3600 + 29 * 60 + 59, 3)).toBe('00:01')
  })
})
