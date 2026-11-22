import { describe, expect, it } from 'vitest'
import { ANTICIPATION_MS, checkTrialTiming, coefficientOfVariation, DEFAULT_FRAME_MS, frameMsFrom, isAnticipation, LONG_FRAME_MS, median, rtFromEvent } from './rt'

describe('anticipation, event time and statistics', () => {
  it('responses under 150 ms are anticipations; 150 and over are real', () => {
    expect(ANTICIPATION_MS).toBe(150)
    expect([0, 100, 149.9].map(isAnticipation)).toEqual([true, true, true])
    expect([150, 151, 900].map(isAnticipation)).toEqual([false, false, false])
  })
  it('RT is the event time minus the onset, and an event before the onset is not a reaction', () => {
    expect(rtFromEvent(1350.5, 1000)).toBe(350.5)
    expect(rtFromEvent(999, 1000)).toBeNull()
    expect(rtFromEvent(1000, 1000)).toBe(0)
  })
  it('median and coefficient of variation', () => {
    expect(median([])).toBeUndefined(); expect(median([5])).toBe(5); expect(median([3, 1, 2])).toBe(2); expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(coefficientOfVariation([100])).toBeUndefined(); expect(coefficientOfVariation([0, 0])).toBeUndefined()
    expect(coefficientOfVariation([100, 100, 100])).toBe(0)
    expect(coefficientOfVariation([90, 110])).toBeCloseTo(Math.sqrt(200) / 100, 6)
  })
})

describe('frame timing', () => {
  it('measures the frame length from deltas, ignoring stalls, and falls back when too few', () => {
    expect(frameMsFrom([])).toBe(DEFAULT_FRAME_MS)
    expect(frameMsFrom([16.7, 16.6, 16.7, 16.8, 16.7, 16.7])).toBeCloseTo(16.7, 1)
    expect(frameMsFrom([16.7, 16.7, 16.7, 16.7, 16.7, 400, 900])).toBeCloseTo(16.7, 1)
    expect(frameMsFrom([6.9, 6.9, 6.9, 6.9, 6.9, 6.9])).toBeCloseTo(6.9, 1) // 144 Hz
    expect(frameMsFrom([1, 1, 1, 1, 1])).toBe(DEFAULT_FRAME_MS) // sub-2 ms deltas are not frames
  })
  const frame = 1000 / 60
  it('accepts a trial shown as planned within two frames', () => {
    expect(checkTrialTiming(600, 600, frame, 17).ok).toBe(true)
    expect(checkTrialTiming(600, 600 + 2 * frame - 0.01, frame, 17).ok).toBe(true)
    expect(checkTrialTiming(600, 600 - 2 * frame + 0.01, frame, 17).ok).toBe(true)
  })
  it('discards a trial whose display missed its time by more than two frames', () => {
    expect(checkTrialTiming(600, 600 + 2 * frame + 0.5, frame, 17)).toEqual({ ok: false, reason: 'display-deviation' })
    expect(checkTrialTiming(600, 520, frame, 17)).toEqual({ ok: false, reason: 'display-deviation' })
  })
  it('discards a trial that saw a frame over 100 ms, whatever the display time', () => {
    expect(LONG_FRAME_MS).toBe(100)
    expect(checkTrialTiming(null, null, frame, 100).ok).toBe(true)
    expect(checkTrialTiming(null, null, frame, 100.1)).toEqual({ ok: false, reason: 'long-frame' })
    expect(checkTrialTiming(600, 600, frame, 250)).toEqual({ ok: false, reason: 'long-frame' })
  })
  it('has nothing to compare for a stimulus shown until answered, or one answered before it vanished', () => {
    expect(checkTrialTiming(null, 5000, frame, 17).ok).toBe(true)
    expect(checkTrialTiming(600, null, frame, 17).ok).toBe(true)
  })
})
