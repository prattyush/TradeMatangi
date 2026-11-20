/** Rule Switch (Flexibility, spec 17.5 #10): apply the rule the cue names to a digit-and-letter card. Pure engine and scoring. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, RULE_SWITCH_PARAMS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, expectedTrials, round3, speedEmphasisScore, speedFactor, volumeFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

export type RsRule = 'number' | 'letter' | 'size'
export type RsKey = 'F' | 'J'
export type RsResponse = RsKey

export const RULE_LABEL: Record<RsRule, { name: string; f: string; j: string; colour: number }> = {
  number: { name: 'NUMBER', f: 'odd', j: 'even', colour: 1 },
  letter: { name: 'LETTER', f: 'vowel', j: 'consonant', colour: 0 },
  size: { name: 'SIZE', f: 'high (over 5)', j: 'low (under 5)', colour: 2 },
}
const RULES: RsRule[] = ['number', 'letter', 'size']
/** 5 is left out so "high or low" is never a tie; odd and even stay four digits each. */
const DIGITS = [1, 2, 3, 4, 6, 7, 8, 9]
const VOWELS = ['A', 'E', 'I', 'O', 'U']
const CONSONANTS = ['K', 'M', 'R', 'T', 'B', 'G', 'L', 'S', 'D', 'N']

export interface RsTrial {
  rule: RsRule
  digit: number
  letter: string
  expected: RsKey
  /** True when the rule differs from the previous judged trial; `null` for the first trial of the block (neither a switch nor a repeat). */
  isSwitch: boolean | null
  /** Cue lead time: 0 means the cue appears together with the card. */
  cueMs: number
  windowMs: number
  gapMs: number
}

export const expectedKey = (rule: RsRule, digit: number, letter: string): RsKey =>
  rule === 'number' ? (digit % 2 === 1 ? 'F' : 'J') : rule === 'letter' ? (VOWELS.includes(letter) ? 'F' : 'J') : digit > 5 ? 'F' : 'J'

export const cueText = (trial: RsTrial): string | null => (trial.cueMs > 0 ? cueLine(trial.rule) : null)
export const cueLine = (rule: RsRule): string => `${RULE_LABEL[rule].name} rule · F = ${RULE_LABEL[rule].f} · J = ${RULE_LABEL[rule].j}`

export function createRuleSwitchEngine(params: Record<string, number>, rng: Rng): TrialEngine<RsTrial, RsResponse> {
  const rules = RULES.slice(0, Math.max(2, Math.min(3, Math.round(params.rules))))
  const random = params.schedule >= 1
  // The previous rule and the count move when a trial is JUDGED, so a trial thrown away for a bad frame leaves no trace.
  let previous: RsRule | null = null
  let judged = 0
  // The predictable pattern is A A B B A A ... starting from whichever rule the first card used.
  let startOffset = 0
  return {
    next() {
      let rule: RsRule
      if (previous === null) { rule = rng.pick(rules); startOffset = rules.indexOf(rule) * 2 }
      else if (!random) rule = rules[Math.floor((judged + startOffset) / 2) % 2] // predictable AABB
      else rule = rng.chance(0.5) ? previous : rng.pick(rules.filter(r => r !== previous))
      const digit = rng.pick(DIGITS)
      const letter = rng.chance(0.5) ? rng.pick(VOWELS) : rng.pick(CONSONANTS)
      return {
        rule, digit, letter, expected: expectedKey(rule, digit, letter), isSwitch: previous === null ? null : rule !== previous,
        cueMs: Math.round(params.cueMs), windowMs: params.windowMs, gapMs: params.gapMs,
      }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.windowMs, gapMs: trial.gapMs, preMs: trial.cueMs }),
    evaluate(trial, response): TrialOutcome {
      previous = trial.rule
      judged += 1
      return { correct: response !== 'timeout' && response === trial.expected, tag: trial.isSwitch === null ? 'first' : trial.isSwitch ? 'switch' : 'repeat' }
    },
  }
}

export const describeRs = (trial: RsTrial): string => `${RULE_LABEL[trial.rule].name}: ${trial.digit} ${trial.letter}${trial.isSwitch ? ' (switch)' : ''}`

export function summariseRuleSwitch(log: TrialLogEntry<RsTrial, RsResponse>[], level: number): SessionSummary {
  const p = paramsAt(RULE_SWITCH_PARAMS, level)
  const valid = log.length
  const correct = log.filter(entry => entry.outcome.correct).length
  const rtOf = (entries: typeof log) => entries.filter(entry => entry.outcome.correct && entry.rtMs !== null).map(entry => entry.rtMs as number)
  const medianRt = median(rtOf(log))
  const skill = choiceSkill(correct, valid, 2)
  const speed = speedFactor(medianRt, p.rtFast, p.rtSlow)
  const expected = expectedTrials(BLOCK_SECONDS.rule_switch, (p.rtFast + p.rtSlow) / 2 + p.cueMs, p.gapMs)
  const score = speedEmphasisScore(skill, speed, volumeFactor(valid, expected))
  const switches = log.filter(entry => entry.trial.isSwitch === true)
  const repeats = log.filter(entry => entry.trial.isSwitch === false)
  const switchRt = median(rtOf(switches)), repeatRt = median(rtOf(repeats))
  const errRate = (entries: typeof log) => (entries.length ? entries.filter(entry => !entry.outcome.correct).length / entries.length : 0)
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: describeRs(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : entry.response, correctAnswer: entry.trial.expected,
    correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      trials: valid, accuracy: valid ? round3(correct / valid) : 0, median_rt: Math.round(medianRt ?? 0),
      switch_rt: Math.round(switchRt ?? 0), repeat_rt: Math.round(repeatRt ?? 0),
      // The cost of switching: how much slower a switch trial is than a repeat (the mixing cost needs a single-task block, which this game does not have).
      switch_cost_ms: switchRt !== undefined && repeatRt !== undefined ? Math.round(switchRt - repeatRt) : 0,
      err_switch_pct: Math.round(errRate(switches) * 100), err_repeat_pct: Math.round(errRate(repeats) * 100),
      error_switch_cost: Math.round((errRate(switches) - errRate(repeats)) * 100),
      switches: switches.length, anticipations: log.filter(entry => entry.outcome.anticipated).length, lapses: log.filter(entry => entry.response === 'timeout').length,
    },
    review,
  }
}

export const ruleSwitchSim: SimPlayer<RsTrial, RsResponse> = {
  correct: trial => trial.expected,
  random: (_trial, rng) => (rng.chance(0.5) ? 'F' : 'J'),
}
