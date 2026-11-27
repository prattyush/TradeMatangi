import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialEngine, TrialLogEntry } from '../../../core/trial'
import { CARD_SORTER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { cardIndex, categoriesFrom, createCardSorterEngine, REFERENCE_CARDS, summariseCardSorter, type CsResponse, type CsTrial } from './engine'

type Engine = TrialEngine<CsTrial, CsResponse>
const make = (level: number, seed = 1): Engine => createCardSorterEngine(paramsAt(CARD_SORTER_PARAMS, level), createRng(seed))
/** Play the whole session with a policy (`answer` gets the trial and returns the reference card index to click). */
function play(level: number, answer: (t: CsTrial) => CsResponse, seed = 1): TrialLogEntry<CsTrial, CsResponse>[] {
  const engine = make(level, seed)
  const log: TrialLogEntry<CsTrial, CsResponse>[] = []
  for (let t = engine.next(); t !== null; t = engine.next()) {
    const response = answer(t)
    log.push({ n: log.length + 1, trial: t, response, rtMs: 900, outcome: engine.evaluate(t, response, 900), atMs: log.length })
  }
  return log
}
const right = (t: CsTrial) => t.correctIndex
const wrongOne = (t: CsTrial) => (t.correctIndex + 1) % 4

describe('Card Sorter engine', () => {
  it('is deterministic for a seed', () => {
    const a = play(8, right, 3), b = play(8, right, 3)
    expect(a.map(e => e.trial)).toEqual(b.map(e => e.trial))
    expect(a.map(e => e.trial)).not.toEqual(play(8, right, 4).map(e => e.trial))
  })
  it('deals exactly 64 cards, counted when judged: a card handed out and discarded does not use one up', () => {
    expect(play(1, right)).toHaveLength(ROUND_COUNTS.card_sorter)
    const engine = make(1)
    for (let i = 0; i < 70; i++) engine.next() // handed out, never judged
    expect(engine.next()).not.toBeNull()
  })
  it('four fixed reference cards differ in every dimension, and a card matches the reference card at its own value', () => {
    expect(REFERENCE_CARDS.map(c => c.colour)).toEqual([0, 1, 2, 3]); expect(REFERENCE_CARDS.map(c => c.shape)).toEqual([0, 1, 2, 3]); expect(REFERENCE_CARDS.map(c => c.count)).toEqual([1, 2, 3, 4])
    for (const e of play(8, right)) { const t = e.trial; expect(t.correctIndex).toBe(cardIndex(t.card, t.rule)); expect(t.card.count).toBeGreaterThanOrEqual(1); expect(t.card.count).toBeLessThanOrEqual(4) }
  })
  it('without ambiguity (level 1) a card points at a different reference card on every dimension', () => {
    for (const e of play(1, right)) { const c = e.trial.card; expect(new Set([c.colour, c.shape, c.count - 1]).size, JSON.stringify(c)).toBe(3); expect(e.trial.ambiguous).toBe(false) }
  })
  it('ambiguous cards (levels 5+) match the current rule and another dimension at once, at about the configured share', () => {
    const log = play(20, right, 2)
    const share = log.filter(e => e.trial.ambiguous).length / log.length
    expect(share).toBeGreaterThan(0.1); expect(share).toBeLessThan(0.4)
    for (const e of log.filter(e => e.trial.ambiguous)) {
      const t = e.trial, indices = [t.card.colour, t.card.shape, t.card.count - 1]
      expect(indices.filter(v => v === t.correctIndex).length, JSON.stringify(t)).toBeGreaterThanOrEqual(2)
    }
  })
  it('the rule changes silently after exactly runLength correct cards in a row, and a mistake restarts the run', () => {
    // level 1: run of 10
    const log = play(1, right)
    const rules = log.map(e => e.trial.rule)
    for (let i = 0; i < 64; i++) expect(rules[i], `card ${i + 1}`).toBe(rules[Math.floor(i / 10) * 10])
    expect(rules[10]).not.toBe(rules[9]); expect(rules[20]).not.toBe(rules[19])
    // one mistake at card 5 delays the first change to card 15 (a new run of 10)
    let n = 0
    const log2 = play(1, t => (++n === 5 ? wrongOne(t) : right(t)))
    expect(log2[14].trial.rule).toBe(log2[0].trial.rule); expect(log2[15].trial.rule).not.toBe(log2[0].trial.rule)
  })
  it('two rules (colour, shape) until level 7, count joins at level 8; a new rule always differs from the one it replaces', () => {
    expect(new Set(play(7, right).map(e => e.trial.rule))).toEqual(new Set([0, 1]))
    const rules = play(20, right, 4).map(e => e.trial.rule)
    expect(new Set(rules)).toEqual(new Set([0, 1, 2]))
    for (let i = 1; i < rules.length; i++) if (rules[i] !== rules[i - 1]) expect(rules[i]).not.toBe(rules[i - 1])
  })
  it('keeps the previous rule on each card after a change, so a perseverative answer can be told apart', () => {
    const log = play(1, right)
    expect(log[0].trial.prevRule).toBeNull(); expect(log[9].trial.prevRule).toBeNull()
    expect(log[10].trial.prevRule).toBe(log[9].trial.rule)
    // answering by the old rule right after the change: tagged perseverative
    const engine = make(1)
    let t = engine.next() as CsTrial
    for (let i = 0; i < 10; i++) { engine.evaluate(t, t.correctIndex, 900); t = engine.next() as CsTrial }
    const oldChoice = cardIndex(t.card, t.prevRule!)
    expect(oldChoice).not.toBe(t.correctIndex)
    expect(engine.evaluate(t, oldChoice, 900)).toMatchObject({ correct: false, tag: 'persev' })
  })
  it('feedback is delayed 600 ms from level 15 (the pause after the card grows to fit it)', () => {
    expect(play(14, right)[0].trial).toMatchObject({ feedbackDelayMs: 0, gapMs: 900 })
    expect(play(15, right)[0].trial).toMatchObject({ feedbackDelayMs: 600, gapMs: 1500 })
  })
})

describe('Card Sorter scoring', () => {
  it('a perfect player completes a category every runLength cards and scores 100', () => {
    for (const level of [1, 10, 20]) {
      const summary = summariseCardSorter(play(level, right), level)
      const run = Math.round(paramsAt(CARD_SORTER_PARAMS, level).runLength)
      expect(summary.score).toBe(100)
      expect(summary.stats).toMatchObject({ categories: Math.floor(64 / run), persev_error_pct: 0, errors: 0 })
    }
  })
  it('replays categories from the log and records cards to the first one', () => {
    const log = play(1, right)
    expect(categoriesFrom(log, 10)).toEqual({ categories: 6, firstCategoryAt: 10 })
    expect(categoriesFrom(play(1, wrongOne), 10)).toEqual({ categories: 0, firstCategoryAt: 0 })
  })
  it('perseveration halves the score at most: score = 100 x categories / target x (1 - 0.5 x perseveration rate)', () => {
    // level 1: target 4 categories; a player who clings to the old rule after each change.
    const engine = make(1, 9)
    const log: TrialLogEntry<CsTrial, CsResponse>[] = []
    for (let t = engine.next(); t !== null; t = engine.next()) {
      const old = t.prevRule !== null ? cardIndex(t.card, t.prevRule) : t.correctIndex
      // cling to the old rule for the first 3 cards after each change, then use the right one
      const response = t.prevRule !== null && log.length % 10 < 3 && old !== t.correctIndex ? old : t.correctIndex
      log.push({ n: log.length + 1, trial: t, response, rtMs: 900, outcome: engine.evaluate(t, response, 900), atMs: log.length })
    }
    const summary = summariseCardSorter(log, 1)
    const errors = log.filter(e => !e.outcome.correct).length
    expect(errors).toBeGreaterThan(0)
    expect(summary.stats!.persev_error_pct).toBe(100)
    expect(summary.score).toBeLessThan(100)
  })
  it('counts failures to maintain set (a slip after five or more correct in a row) and guessing scores nothing', () => {
    let n = 0
    const log = play(1, t => (++n === 7 ? wrongOne(t) : right(t)))
    expect(summariseCardSorter(log, 1).stats).toMatchObject({ failures_to_maintain_set: 1, errors: 1 })
    let k = 0
    expect(summariseCardSorter(play(1, t => (k++ % 2 ? t.correctIndex : wrongOne(t))), 1).score).toBe(0)
  })
})
