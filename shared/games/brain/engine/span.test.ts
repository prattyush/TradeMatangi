import { describe, expect, it } from 'vitest'
import { adjustedFraction, createSpanTracker, gainTargetFor, spanScore } from './span'

const rules = { startSpan: 3, step: 1, maxSpan: 12, gainTarget: 6, maxTrials: 9 }

describe('span tracker', () => {
  it('a success raises the span by the step; a failure keeps it and costs a strike', () => {
    const t = createSpanTracker(rules)
    expect(t.span).toBe(3)
    t.record(true); expect([t.span, t.peak, t.strikes, t.played]).toEqual([4, 3, 0, 1])
    t.record(false); expect([t.span, t.peak, t.strikes, t.played]).toEqual([4, 3, 1, 2])
    t.record(true); expect([t.span, t.peak]).toEqual([5, 4])
  })
  it('three strikes end the game, not before', () => {
    const t = createSpanTracker(rules)
    t.record(false); t.record(true); t.record(false)
    expect(t.finished()).toBe(false)
    t.record(false)
    expect(t.finished()).toBe(true)
  })
  it('the trial cap and the span ceiling end a perfect run', () => {
    const capped = createSpanTracker(rules)
    for (let i = 0; i < 9; i++) { expect(capped.finished()).toBe(false); capped.record(true) }
    expect(capped.finished()).toBe(true); expect(capped.peak).toBe(11)
    const ceiling = createSpanTracker({ ...rules, startSpan: 3, step: 2, maxSpan: 7, maxTrials: 99 })
    ceiling.record(true); ceiling.record(true); expect(ceiling.finished()).toBe(false)
    ceiling.record(true) // succeeds at the ceiling
    expect(ceiling.finished()).toBe(true); expect(ceiling.peak).toBe(7); expect(ceiling.span).toBe(7)
  })
  it('the span never goes past the ceiling', () => {
    const t = createSpanTracker({ ...rules, startSpan: 11, step: 2, maxSpan: 12, maxTrials: 99 })
    t.record(true)
    expect(t.span).toBe(12)
  })
})

describe('span scoring', () => {
  it('gain target is capped at six and at what the ceiling allows', () => {
    expect(gainTargetFor(3, 7)).toBe(5)
    expect(gainTargetFor(3, 12)).toBe(6)
    expect(gainTargetFor(6, 12)).toBe(6)
    expect(gainTargetFor(12, 12)).toBe(1)
  })
  it('chance-corrected fraction: 0 at chance, 1 when all right, clamped', () => {
    expect(adjustedFraction(1, 0.1)).toBe(1)
    expect(adjustedFraction(0.1, 0.1)).toBe(0)
    expect(adjustedFraction(0, 0.5)).toBe(0)
    expect(adjustedFraction(0.75, 0.5)).toBeCloseTo(0.5)
    expect(adjustedFraction(1, 1)).toBe(0)
  })
  it('hand-computed: 100 * (0.7 * progress + 0.3 * accuracy)', () => {
    expect(spanScore(3, 7, 5, 1)).toBe(100) // gained 5 of 5, perfect recall
    expect(spanScore(3, 5, 6, 0.8)).toBe(Math.round(100 * (0.7 * (3 / 6) + 0.3 * 0.8))) // 59
    expect(spanScore(3, 0, 6, 0.4)).toBe(12) // the first trial failed: no gain, only the accuracy part
    expect(spanScore(3, 12, 6, 2)).toBe(100)
  })
})
