import { describe, expect, it } from 'vitest'
import { choiceSkill, detectionSkill, expectedTrials, speedEmphasisScore, speedFactor, volumeFactor } from './scoringBrain'

describe('chance-corrected skill', () => {
  it('choice tasks: chance scores 0, perfect scores 1, below chance is clamped to 0', () => {
    expect(choiceSkill(50, 100, 2)).toBe(0)
    expect(choiceSkill(25, 100, 4)).toBe(0)
    expect(choiceSkill(100, 100, 2)).toBe(1)
    expect(choiceSkill(75, 100, 2)).toBeCloseTo(0.5)
    expect(choiceSkill(40, 100, 2)).toBe(0)
    expect(choiceSkill(55, 100, 4)).toBeCloseTo(0.4)
    expect(choiceSkill(0, 0, 2)).toBe(0)
    expect(choiceSkill(3, 4, 1)).toBe(0)
  })
  it('detection tasks: always pressing or never pressing scores 0 (hit rate minus false-alarm rate)', () => {
    expect(detectionSkill(30, 30, 10, 10)).toBe(0) // always press
    expect(detectionSkill(0, 30, 0, 10)).toBe(0) // never press
    expect(detectionSkill(30, 30, 0, 10)).toBe(1)
    expect(detectionSkill(24, 30, 2, 10)).toBeCloseTo(0.6)
    expect(detectionSkill(10, 30, 8, 10)).toBe(0)
    expect(detectionSkill(5, 0, 1, 1)).toBe(0)
  })
})

describe('speed and volume', () => {
  it('speed factor runs from 1 at RT_fast to 0 at RT_slow', () => {
    expect(speedFactor(450, 450, 1800)).toBe(1)
    expect(speedFactor(300, 450, 1800)).toBe(1)
    expect(speedFactor(1800, 450, 1800)).toBe(0)
    expect(speedFactor(2500, 450, 1800)).toBe(0)
    expect(speedFactor(1125, 450, 1800)).toBeCloseTo(0.5)
    expect(speedFactor(undefined, 450, 1800)).toBe(0)
    expect(speedFactor(NaN, 450, 1800)).toBe(0)
    expect(speedFactor(500, 800, 800)).toBe(1) // degenerate range
  })
  it('a block with too few trials is scaled down by completed / (0.6 * expected), at most 1', () => {
    expect(volumeFactor(30, 50)).toBe(1)
    expect(volumeFactor(18, 50)).toBeCloseTo(0.6)
    expect(volumeFactor(2, 50)).toBeCloseTo(2 / 30)
    expect(volumeFactor(100, 50)).toBe(1)
    expect(volumeFactor(0, 50)).toBe(0)
    expect(volumeFactor(5, 0)).toBe(1)
  })
  it('expected trials: block time over (mid RT + gap)', () => {
    expect(expectedTrials(60, 1125, 400)).toBe(39)
    expect(expectedTrials(60, 0, 0)).toBe(0)
  })
})

describe('speed-emphasis score', () => {
  it('hand-computed: 100 * skill * (0.6 + 0.4 * speed) * volume', () => {
    expect(speedEmphasisScore(1, 1, 1)).toBe(100)
    expect(speedEmphasisScore(1, 0, 1)).toBe(60)
    expect(speedEmphasisScore(0.5, 0.5, 1)).toBe(40) // 100 * 0.5 * 0.8
    expect(speedEmphasisScore(0.8, 1, 0.5)).toBe(40)
    expect(speedEmphasisScore(1, 1, 1, 0.3)).toBe(100)
    expect(speedEmphasisScore(1, 0, 1, 0.3)).toBe(70) // Green Light: 0.7 floor
  })
  it('stays within 0..100 and survives bad numbers', () => {
    expect(speedEmphasisScore(2, 2, 2)).toBe(100)
    expect(speedEmphasisScore(-1, 1, 1)).toBe(0)
    expect(speedEmphasisScore(NaN, 1, 1)).toBe(0)
    expect(Number.isFinite(speedEmphasisScore(Infinity, 1, 1))).toBe(true)
  })
})
