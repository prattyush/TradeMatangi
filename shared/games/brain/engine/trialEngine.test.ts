import { describe, expect, it } from 'vitest'
import type { TrialEngine, TrialResponse } from '../../core/trial'
import { createBlock } from './trialEngine'

/** Trials 1..n; the right answer is "yes" for odd numbers. */
const engineOf = (count: number): TrialEngine<number, 'yes' | 'no'> => {
  let i = 0
  return {
    next: () => (i < count ? ++i : null),
    timing: () => ({ displayMs: null, windowMs: 1000, gapMs: 100 }),
    evaluate: (trial, response: TrialResponse<'yes' | 'no'>) => ({ correct: response === (trial % 2 ? 'yes' : 'no') }),
  }
}

describe('block runner', () => {
  it('issues trials until the clock runs out, then stops', () => {
    const block = createBlock(engineOf(100), { seconds: 10 })
    expect(block.issue(0)).toBe(1)
    block.answer('yes', 400, 400)
    expect(block.issue(9999)).toBe(2)
    block.answer('no', 400, 9999)
    expect(block.issue(10_000)).toBeNull()
    expect(block.isOver(10_000)).toBe(true)
    expect(block.log).toHaveLength(2)
  })
  it('ends when the engine ends, and respects a trial cap', () => {
    const short = createBlock(engineOf(1), { seconds: 60 })
    short.issue(0); short.answer('yes', 300, 300)
    expect(short.issue(500)).toBeNull(); expect(short.isOver(500)).toBe(true)
    const capped = createBlock(engineOf(50), { seconds: 60, maxTrials: 2 })
    for (let i = 0; i < 5; i++) { if (capped.issue(i) === null) break; capped.answer('yes', 300, i) }
    expect(capped.log).toHaveLength(2)
  })
  it('logs the response, the RT, the outcome and numbers the trials from 1', () => {
    const block = createBlock(engineOf(3), { seconds: 60 })
    block.issue(0)
    const first = block.answer('yes', 412.5, 412.5)
    expect(first).toMatchObject({ n: 1, trial: 1, response: 'yes', rtMs: 412.5, outcome: { correct: true }, atMs: 412.5 })
    block.issue(600)
    expect(block.answer('yes', 380, 980)).toMatchObject({ n: 2, outcome: { correct: false } })
  })
  it('a lapse (no response) is logged with no RT', () => {
    const block = createBlock(engineOf(2), { seconds: 60 })
    block.issue(0)
    expect(block.answer('timeout', 1000, 1000)).toMatchObject({ response: 'timeout', rtMs: null, outcome: { correct: false } })
  })
  it('a response under 150 ms is an error and carries no RT, even if the answer was right', () => {
    const block = createBlock(engineOf(2), { seconds: 60 })
    block.issue(0)
    const entry = block.answer('yes', 120, 120)
    expect(entry.outcome).toMatchObject({ correct: false, anticipated: true, tag: 'early' })
    expect(entry.rtMs).toBeNull()
    block.issue(500)
    expect(block.answer('no', 150, 650).outcome).toMatchObject({ correct: true })
  })
  it('keeps a false-alarm tag on an anticipated response', () => {
    const engine: TrialEngine<number, 'press'> = {
      next: () => 1, timing: () => ({ displayMs: 500, windowMs: 600, gapMs: 100 }),
      evaluate: (_t, response) => (response === 'press' ? { correct: false, tag: 'fa' } : { correct: true, tag: 'cr' }),
    }
    const block = createBlock(engine, { seconds: 10 })
    block.issue(0)
    expect(block.answer('press', 90, 90).outcome).toMatchObject({ tag: 'fa', anticipated: true, correct: false })
  })
  it('a discarded trial is not logged, not scored, and is counted', () => {
    const block = createBlock(engineOf(5), { seconds: 60 })
    block.issue(0); block.discard()
    expect(block.log).toHaveLength(0); expect(block.discarded).toBe(1); expect(block.current).toBeNull()
    expect(block.issue(300)).toBe(2) // a replacement is a new trial from the engine
    block.discard(); block.discard() // nothing pending: no double count
    expect(block.discarded).toBe(2)
  })
  it('refuses to answer without a trial', () => {
    expect(() => createBlock(engineOf(1), { seconds: 5 }).answer('yes', 300, 300)).toThrow()
  })
})
