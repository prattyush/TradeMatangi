/** Sequence Echo (Memory, spec 17.5 #5): repeat the sequence in order, or backwards. Pure engine, scoring and sim profile. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, StageSpec, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { SEQUENCE_ECHO_PARAMS, SPAN_CAP } from '../../config/difficulty.brain'
import { adjustedFraction, createSpanTracker, gainTargetFor, spanScore } from '../../engine/span'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

/** Item numbers entered, in the order entered. */
export type SeResponse = number[]

/** One thing shown during the sequence: an item to remember, or (from level 15) a distractor flash to ignore. */
export interface SeEvent { item: number; distractor: boolean }
export interface SeTrial {
  span: number
  /** The items to remember, in order (0 .. items-1). */
  sequence: number[]
  /** Everything shown, in order, distractor flashes included. */
  events: SeEvent[]
  backward: boolean
  /** 0 coloured pads, 1 digits, 2 letters */
  kind: 0 | 1 | 2
  items: number
  itemMs: number
  gapMs: number
}

export interface SeRules { startSpan: number; maxSpan: number; gainTarget: number; maxTrials: number }
export function seRules(params: Record<string, number>): SeRules {
  const startSpan = Math.round(params.startSpan)
  const gainTarget = gainTargetFor(startSpan, SPAN_CAP, params.backward >= 1 ? 5 : 6)
  return { startSpan, maxSpan: SPAN_CAP, gainTarget, maxTrials: gainTarget + 3 }
}

export const seExpected = (trial: SeTrial): number[] => (trial.backward ? [...trial.sequence].reverse() : trial.sequence)

export function seGrade(trial: SeTrial, response: SeResponse) {
  const expected = seExpected(trial)
  const right = expected.reduce((count, item, i) => count + (response[i] === item ? 1 : 0), 0)
  const distractors = new Set(trial.events.filter(e => e.distractor).map(e => e.item))
  const intrusions = response.filter((item, i) => item !== expected[i] && distractors.has(item) && !trial.sequence.includes(item)).length
  return { fraction: right / trial.span, chance: 1 / trial.items, success: right === trial.span && response.length === trial.span, intrusions }
}

export function createSequenceEchoEngine(params: Record<string, number>, rng: Rng): TrialEngine<SeTrial, SeResponse> {
  const rules = seRules(params)
  const tracker = createSpanTracker({ ...rules, step: 1 })
  const items = Math.round(params.items)
  const kind = Math.min(2, Math.max(0, Math.round(params.kind))) as 0 | 1 | 2
  const backward = params.backward >= 1
  const distractors = params.distractor >= 1
  return {
    next() {
      if (tracker.finished()) return null
      const span = tracker.span
      const sequence: number[] = []
      for (let i = 0; i < span; i++) {
        // No item twice in a row: it would read as one longer flash.
        let item = rng.int(0, items - 1)
        while (items > 1 && item === sequence[i - 1]) item = rng.int(0, items - 1)
        sequence.push(item)
      }
      const events: SeEvent[] = []
      sequence.forEach((item, i) => {
        events.push({ item, distractor: false })
        if (distractors && i < sequence.length - 1 && rng.chance(0.6)) {
          let other = rng.int(0, items - 1)
          while (items > 2 && (other === item || other === sequence[i + 1])) other = rng.int(0, items - 1)
          events.push({ item: other, distractor: true })
        }
      })
      return { span, sequence, events, backward, kind, items, itemMs: params.itemMs, gapMs: params.gapMs }
    },
    timing: (): TrialTiming => ({ displayMs: null, windowMs: 600_000, gapMs: 0 }),
    stages: (trial): StageSpec[] => [
      { name: 'ready', ms: 600 },
      { name: 'show', ms: trial.events.length * (trial.itemMs + trial.gapMs) + 300, critical: true },
      { name: 'respond', ms: null },
    ],
    evaluate(trial, response): TrialOutcome {
      const grade = seGrade(trial, response === 'timeout' ? [] : response)
      tracker.record(grade.success)
      return { correct: grade.success }
    },
    progress: () => ({ span: tracker.span, strikes: tracker.strikes, trial: tracker.played, of: rules.maxTrials }),
  }
}

const KIND_LABEL = ['pads', 'digits', 'letters']
export const seLabel = (kind: 0 | 1 | 2, item: number): string => (kind === 0 ? String(item + 1) : kind === 1 ? String(item + 1) : String.fromCharCode(65 + item))
export const describeSe = (trial: SeTrial): string =>
  `span ${trial.span} (${KIND_LABEL[trial.kind]}${trial.backward ? ', backwards' : ''}): ${trial.events.map(e => (e.distractor ? `[${seLabel(trial.kind, e.item)}]` : seLabel(trial.kind, e.item))).join(' ')}`

export function summariseSequenceEcho(log: TrialLogEntry<SeTrial, SeResponse>[], level: number): SessionSummary {
  const rules = seRules(paramsAt(SEQUENCE_ECHO_PARAMS, level))
  const graded = log.map(entry => ({ entry, grade: seGrade(entry.trial, entry.response === 'timeout' ? [] : entry.response) }))
  const peak = Math.max(0, ...graded.filter(g => g.grade.success).map(g => g.entry.trial.span))
  const meanAdjusted = graded.length ? graded.reduce((sum, g) => sum + adjustedFraction(g.grade.fraction, g.grade.chance), 0) / graded.length : 0
  // Where in the sequence the mistakes fall: first, middle or last third (the serial-position curve).
  const errors = { first: 0, middle: 0, last: 0 }
  for (const { entry } of graded) {
    const expected = seExpected(entry.trial)
    const response = entry.response === 'timeout' ? [] : entry.response
    expected.forEach((item, i) => { if (response[i] !== item) errors[i < expected.length / 3 ? 'first' : i < (2 * expected.length) / 3 ? 'middle' : 'last'] += 1 })
  }
  const review: ReviewRow[] = graded.slice(0, 250).map(({ entry, grade }) => ({
    n: entry.n, shown: describeSe(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : entry.response.map(i => seLabel(entry.trial.kind, i)).join(' '),
    correctAnswer: seExpected(entry.trial).map(i => seLabel(entry.trial.kind, i)).join(' '), correct: grade.success, rtMs: null,
  }))
  return {
    score: spanScore(rules.startSpan, peak, rules.gainTarget, meanAdjusted),
    stats: {
      peak_span: peak, mean_accuracy: graded.length ? round3(graded.reduce((s, g) => s + g.grade.fraction, 0) / graded.length) : 0,
      backward: paramsAt(SEQUENCE_ECHO_PARAMS, level).backward >= 1 ? 1 : 0, strikes: graded.filter(g => !g.grade.success).length, trials: graded.length,
      err_first: errors.first, err_middle: errors.middle, err_last: errors.last, intrusions: graded.reduce((s, g) => s + g.grade.intrusions, 0),
    },
    review,
  }
}

export const sequenceEchoSim: SimPlayer<SeTrial, SeResponse> = {
  correct: seExpected,
  random: (trial, rng) => Array.from({ length: trial.span }, () => rng.int(0, trial.items - 1)),
}
