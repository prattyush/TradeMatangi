import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { RULE_SWITCH_PARAMS } from '../../config/difficulty.brain'
import { createRuleSwitchEngine, cueLine, cueText, expectedKey, summariseRuleSwitch, type RsResponse, type RsRule, type RsTrial } from './engine'

/** Play `count` trials the way a perfect player does, so the engine's judged-trial state moves. */
const play = (level: number, count: number, seed = 1): RsTrial[] => {
  const engine = createRuleSwitchEngine(paramsAt(RULE_SWITCH_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => { const t = engine.next() as RsTrial; engine.evaluate(t, t.expected, 500); return t })
}
const entry = (n: number, trial: RsTrial, response: RsResponse | 'timeout', rtMs: number | null, correct: boolean, anticipated = false): TrialLogEntry<RsTrial, RsResponse> =>
  ({ n, trial, response, rtMs, outcome: { correct, tag: String(trial.isSwitch), anticipated }, atMs: n })

describe('Rule Switch engine', () => {
  it('is deterministic for a seed', () => { expect(play(8, 40, 3)).toEqual(play(8, 40, 3)); expect(play(8, 40, 3)).not.toEqual(play(8, 40, 4)) })
  it('the expected key follows the rule: odd/vowel/over 5 = F, even/consonant/under 5 = J', () => {
    expect(expectedKey('number', 7, 'K')).toBe('F'); expect(expectedKey('number', 4, 'A')).toBe('J')
    expect(expectedKey('letter', 4, 'A')).toBe('F'); expect(expectedKey('letter', 7, 'K')).toBe('J')
    expect(expectedKey('size', 9, 'K')).toBe('F'); expect(expectedKey('size', 2, 'A')).toBe('J')
    for (const t of play(20, 200)) expect(t.expected).toBe(expectedKey(t.rule, t.digit, t.letter))
  })
  it('levels 1 to 5 alternate predictably in pairs (A A B B A A ...), for either starting rule', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const trials = play(3, 12, seed)
      const rules = trials.map(t => t.rule)
      for (let i = 0; i + 1 < rules.length; i += 2) expect(rules[i], `seed ${seed}`).toBe(rules[i + 1])
      for (let i = 0; i + 2 < rules.length; i += 2) expect(rules[i]).not.toBe(rules[i + 2])
    }
  })
  it('from level 6 the rule switches on about half the trials; the very first trial is neither a switch nor a repeat', () => {
    const trials = play(10, 600)
    expect(trials[0].isSwitch).toBeNull()
    const share = trials.slice(1).filter(t => t.isSwitch).length / 599
    expect(share).toBeGreaterThan(0.4); expect(share).toBeLessThan(0.6)
    for (let i = 1; i < trials.length; i++) expect(trials[i].isSwitch).toBe(trials[i].rule !== trials[i - 1].rule)
  })
  it('two rules until level 15, the size rule from level 16', () => {
    expect(new Set(play(15, 200).map(t => t.rule))).toEqual(new Set<RsRule>(['number', 'letter']))
    expect(new Set(play(16, 300).map(t => t.rule))).toEqual(new Set<RsRule>(['number', 'letter', 'size']))
  })
  it('digits skip 5 and both response keys are used; every card carries a digit and a letter', () => {
    const trials = play(1, 200)
    expect(trials.every(t => t.digit !== 5 && t.digit >= 1 && t.digit <= 9 && /^[A-Z]$/.test(t.letter))).toBe(true)
    expect(new Set(trials.map(t => t.expected))).toEqual(new Set(['F', 'J']))
  })
  it('the cue leads the card by 1000 ms (L1-5), 500 ms (L6-12) and not at all (L13+, cue with the card)', () => {
    expect(play(1, 1)[0]).toMatchObject({ cueMs: 1000 }); expect(play(5, 1)[0].cueMs).toBe(1000)
    expect(play(6, 1)[0].cueMs).toBe(500); expect(play(12, 1)[0].cueMs).toBe(500)
    expect(play(13, 1)[0].cueMs).toBe(0)
    const engine = createRuleSwitchEngine(paramsAt(RULE_SWITCH_PARAMS, 13), createRng(1))
    expect(engine.timing(engine.next() as RsTrial).preMs).toBe(0)
    expect(cueText(play(13, 1)[0])).toBeNull(); expect(cueText(play(1, 1)[0])).toBe(cueLine(play(1, 1)[0].rule))
  })
  it('a trial thrown away for a bad frame changes nothing: the next trial is the same kind of step', () => {
    const e = createRuleSwitchEngine(paramsAt(RULE_SWITCH_PARAMS, 10), createRng(2))
    const first = e.next() as RsTrial
    e.evaluate(first, first.expected, 500)
    const dropped = e.next() as RsTrial // handed out, never judged
    const replacement = e.next() as RsTrial
    expect(dropped.isSwitch === (dropped.rule !== first.rule)).toBe(true)
    expect(replacement.isSwitch === (replacement.rule !== first.rule)).toBe(true)
  })
  it('judges only the key for the rule on the card', () => {
    const e = createRuleSwitchEngine(paramsAt(RULE_SWITCH_PARAMS, 1), createRng(2)), t = e.next() as RsTrial
    expect(e.evaluate(t, t.expected, 500).correct).toBe(true)
    expect(e.evaluate(t, t.expected === 'F' ? 'J' : 'F', 500).correct).toBe(false)
    expect(e.evaluate(t, 'timeout', 3500).correct).toBe(false)
  })
})

describe('Rule Switch scoring', () => {
  const trials = play(10, 80)
  const sw = trials.find(t => t.isSwitch === true)!, rep = trials.find(t => t.isSwitch === false)!
  it('switch cost is the median switch RT minus the median repeat RT; error switch cost likewise', () => {
    const log = [
      entry(1, rep, rep.expected, 500, true), entry(2, rep, rep.expected, 540, true), entry(3, sw, sw.expected, 700, true), entry(4, sw, sw.expected, 740, true),
      entry(5, sw, sw.expected === 'F' ? 'J' : 'F', 800, false), entry(6, rep, rep.expected, 520, true),
    ]
    expect(summariseRuleSwitch(log, 10).stats).toMatchObject({ switch_rt: 720, repeat_rt: 520, switch_cost_ms: 200, err_switch_pct: 33, err_repeat_pct: 0, error_switch_cost: 33, switches: 3 })
  })
  it('hand-computed at level 1: 36 of 40 right at a median of 700 ms scores like the other speed games', () => {
    const t1 = play(1, 40)
    const log = t1.map((t, i) => (i < 36 ? entry(i + 1, t, t.expected, 700, true) : entry(i + 1, t, t.expected === 'F' ? 'J' : 'F', 600, false)))
    // skill (0.9 - 0.5) / 0.5 = 0.8; speed (2200 - 700) / (2200 - 600) = 0.9375; 100 * 0.8 * (0.6 + 0.4 * 0.9375) = 78; volume: 40 trials, enough
    expect(summariseRuleSwitch(log, 1).score).toBe(78)
  })
  it('guessing scores nothing and an anticipation is an error without an RT', () => {
    const guess = trials.map((t, i) => entry(i + 1, t, i % 2 ? t.expected : (t.expected === 'F' ? 'J' : 'F'), 400, i % 2 === 1))
    expect(summariseRuleSwitch(guess, 1).score).toBe(0)
    expect(summariseRuleSwitch([entry(1, rep, rep.expected, null, false, true)], 1).stats).toMatchObject({ anticipations: 1 })
  })
})
