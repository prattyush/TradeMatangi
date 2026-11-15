import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { SEQUENCE_ECHO_PARAMS } from '../../config/difficulty.brain'
import { createSequenceEchoEngine, describeSe, seExpected, seGrade, seLabel, seRules, summariseSequenceEcho, type SeResponse, type SeTrial } from './engine'

const engine = (level: number, seed = 1) => createSequenceEchoEngine(paramsAt(SEQUENCE_ECHO_PARAMS, level), createRng(seed))
const make = (level: number, seed = 1): SeTrial => engine(level, seed).next() as SeTrial
const entry = (n: number, trial: SeTrial, response: SeResponse): TrialLogEntry<SeTrial, SeResponse> => ({ n, trial, response, rtMs: null, outcome: { correct: seGrade(trial, response).success }, atMs: n })

describe('Sequence Echo engine', () => {
  it('is deterministic; items stay inside the set; no item twice in a row', () => {
    expect(make(10, 3)).toEqual(make(10, 3)); expect(make(10, 3)).not.toEqual(make(10, 4))
    for (let seed = 1; seed < 40; seed++) {
      const t = make(1, seed)
      expect(t.sequence.every(i => i >= 0 && i < 4)).toBe(true)
      t.sequence.forEach((item, i) => { if (i) expect(item).not.toBe(t.sequence[i - 1]) })
    }
  })
  it('item count, kind, timing and direction follow the level', () => {
    expect(make(1)).toMatchObject({ items: 4, kind: 0, itemMs: 800, backward: false, span: 3 })
    expect(make(10)).toMatchObject({ items: 6, kind: 1, itemMs: 500, backward: true, span: 4 })
    expect(make(20)).toMatchObject({ items: 9, kind: 2, itemMs: 300, backward: true, span: 6 })
    expect(make(7).backward).toBe(false); expect(make(8).backward).toBe(true)
    expect(make(9).kind).toBe(0); expect(make(10).kind).toBe(1); expect(make(17).kind).toBe(1); expect(make(18).kind).toBe(2)
  })
  it('distractor flashes appear only from level 15, never as part of the sequence, never equal to a neighbour', () => {
    expect(Array.from({ length: 30 }, (_, i) => make(14, i + 1)).every(t => t.events.every(e => !e.distractor))).toBe(true)
    const hard = Array.from({ length: 30 }, (_, i) => make(15, i + 1))
    expect(hard.some(t => t.events.some(e => e.distractor))).toBe(true)
    for (const t of hard) {
      expect(t.events.filter(e => !e.distractor).map(e => e.item)).toEqual(t.sequence)
      t.events.forEach((e, i) => { if (e.distractor) { expect(e.item).not.toBe(t.events[i - 1].item); expect(e.item).not.toBe(t.events[i + 1].item) } })
    }
  })
  it('rules: gain target 6 forward and 5 backward, at most nine rounds, ceiling 12', () => {
    expect(seRules(paramsAt(SEQUENCE_ECHO_PARAMS, 1))).toMatchObject({ startSpan: 3, maxSpan: 12, gainTarget: 6, maxTrials: 9 })
    expect(seRules(paramsAt(SEQUENCE_ECHO_PARAMS, 10))).toMatchObject({ startSpan: 4, gainTarget: 5, maxTrials: 8 })
  })
  it('the span rises one at a time, strikes end it, and a perfect player stops at the trial cap', () => {
    const e = engine(1)
    const spans: number[] = []
    for (let t = e.next() as SeTrial | null; t; t = e.next() as SeTrial | null) { spans.push(t.span); e.evaluate(t, seExpected(t)) }
    expect(spans).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])
    const f = engine(1)
    for (let i = 0; i < 3; i++) f.evaluate(f.next() as SeTrial, [])
    expect(f.next()).toBeNull()
  })
  it('stages: ready, a critical show stage covering every flash, then the open answer', () => {
    const t = make(15), stages = engine(15).stages!(t)
    expect(stages.map(s => s.name)).toEqual(['ready', 'show', 'respond'])
    expect(stages[1]).toMatchObject({ critical: true, ms: t.events.length * (t.itemMs + t.gapMs) + 300 })
  })
})

describe('Sequence Echo grading and scoring', () => {
  const base: SeTrial = { span: 4, sequence: [0, 2, 1, 3], events: [], backward: false, kind: 1, items: 6, itemMs: 500, gapMs: 250 }
  it('forward must match in order; backward expects it reversed', () => {
    expect(seGrade(base, [0, 2, 1, 3]).success).toBe(true)
    expect(seGrade(base, [0, 2, 3, 1])).toMatchObject({ success: false, fraction: 0.5 })
    const back = { ...base, backward: true }
    expect(seExpected(back)).toEqual([3, 1, 2, 0]); expect(seGrade(back, [3, 1, 2, 0]).success).toBe(true)
    expect(seGrade(back, [0, 2, 1, 3]).success).toBe(false)
    expect(seGrade(base, []).chance).toBeCloseTo(1 / 6)
  })
  it('counts an intrusion when a distractor item is entered where it does not belong', () => {
    const withDistractor: SeTrial = { ...base, sequence: [0, 2, 1, 3], events: [{ item: 0, distractor: false }, { item: 5, distractor: true }, { item: 2, distractor: false }, { item: 1, distractor: false }, { item: 3, distractor: false }] }
    expect(seGrade(withDistractor, [0, 5, 1, 3]).intrusions).toBe(1)
    expect(seGrade(withDistractor, [0, 2, 1, 3]).intrusions).toBe(0)
    expect(seGrade(withDistractor, [0, 4, 1, 3]).intrusions).toBe(0) // a wrong item that was not a distractor is just an error
  })
  it('hand-computed, with the serial-position error profile', () => {
    const t4: SeTrial = { ...base, span: 6, sequence: [0, 1, 2, 3, 4, 5], items: 6, kind: 1 }
    const log = [entry(1, { ...base, span: 3, sequence: [0, 1, 2] }, [0, 1, 2]), entry(2, { ...base, span: 4, sequence: [0, 1, 2, 3] }, [0, 1, 2, 3]), entry(3, t4, [0, 1, 9, 3, 4, 8])]
    const summary = summariseSequenceEcho(log, 10)
    // level 10 start 4, backward -> gain target 5; peak 4 -> gain 1 -> progress .2
    expect(summary.stats).toMatchObject({ peak_span: 4, trials: 3, strikes: 1, backward: 1, err_first: 0, err_middle: 1, err_last: 1 })
    const adjusted = (1 + 1 + (4 / 6 - 1 / 6) / (1 - 1 / 6)) / 3
    expect(summary.score).toBe(Math.round(100 * (0.7 * 0.2 + 0.3 * adjusted)))
    expect(summary.review![2]).toMatchObject({ correct: false })
  })
  it('labels: pads and digits are numbered from 1, letters from A; trials describe distractors in brackets', () => {
    expect([seLabel(0, 0), seLabel(1, 4), seLabel(2, 0), seLabel(2, 8)]).toEqual(['1', '5', 'A', 'I'])
    expect(describeSe({ ...base, events: [{ item: 0, distractor: false }, { item: 4, distractor: true }] })).toContain('[5]')
  })
})
