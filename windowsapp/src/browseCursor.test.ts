import { describe, expect, it } from 'vitest'
import { acceptCursor } from '../../shared/browse/browseModel'

const OCT_27_0915 = Date.parse('2026-10-27T09:15:00Z') / 1000
const NOV_18_0915 = Date.parse('2026-11-18T09:15:00Z') / 1000

describe('acceptCursor (scroll-back after an interval switch)', () => {
  it('answers the cursor of the candles that are held, and one that is newer', () => {
    expect(acceptCursor('NIFTY:5', 'NIFTY:5', NOV_18_0915, NOV_18_0915)).toBe(true)
    expect(acceptCursor('NIFTY:5', 'NIFTY:5', OCT_27_0915, NOV_18_0915)).toBe(true)
  })

  it('does not answer a cursor older than anything held for the new interval (the hole seen on 5m: 3m data from 27 Oct, 5m first load from 18 Nov)', () => {
    expect(acceptCursor('NIFTY:5', 'NIFTY:5', NOV_18_0915, OCT_27_0915)).toBe(false)
  })

  it('does not answer while the held candles belong to another pane or interval, or before the first load has arrived', () => {
    expect(acceptCursor('NIFTY:3', 'NIFTY:5', OCT_27_0915, OCT_27_0915)).toBe(false)
    expect(acceptCursor('', 'NIFTY:5', undefined, NOV_18_0915)).toBe(false)
    expect(acceptCursor('NIFTY:5', 'NIFTY:5', undefined, NOV_18_0915)).toBe(false)
    expect(acceptCursor(null, 'NIFTY:5', NOV_18_0915, NOV_18_0915)).toBe(false)
    expect(acceptCursor('NIFTY:5', 'NIFTY:5', NOV_18_0915, Number.NaN)).toBe(false)
  })
})
