/** Colour Clash (Speed, spec 17.5 #2): name the ink colour, not the word (Stroop). Pure engine, scoring and sim profile. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, COLOUR_CLASH_PARAMS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, expectedTrials, round3, speedEmphasisScore, speedFactor, volumeFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import { PALETTE } from '../../ui/palette'

export type CcKind = 'congruent' | 'incongruent' | 'neutral'
/** The answer is the palette index of the ink colour. */
export type CcResponse = number

export interface CcTrial {
  kind: CcKind
  /** Palette index of the colour word shown, or `null` for a neutral trial (XXXX). */
  word: number | null
  /** Palette index the text is printed in: the right answer. */
  ink: number
  /** Order of the answer swatches (palette indices), left to right. Shuffled every trial from level 16. */
  order: number[]
  windowMs: number
  gapMs: number
}

const CHUNK = 20

export function createColourClashEngine(params: Record<string, number>, rng: Rng): TrialEngine<CcTrial, CcResponse> {
  const k = Math.min(PALETTE.length, Math.max(2, Math.round(params.colours)))
  const shuffle = params.shuffle >= 1
  // Shares are exact in every run of twenty trials.
  const incongruent = Math.round((params.incongruentPct * CHUNK) / 100)
  const neutral = Math.round((params.neutralPct * CHUNK) / 100)
  const congruent = Math.max(0, CHUNK - incongruent - neutral)
  let queue: CcKind[] = []
  let previous: string | null = null
  const identity = Array.from({ length: k }, (_, i) => i)

  return {
    next() {
      if (!queue.length) queue = rng.shuffle<CcKind>([...Array(incongruent).fill('incongruent'), ...Array(neutral).fill('neutral'), ...Array(congruent).fill('congruent')])
      const kind = queue.pop() as CcKind
      let ink = rng.int(0, k - 1)
      let word: number | null = kind === 'neutral' ? null : ink
      // Do not repeat the exact same stimulus twice in a row.
      for (let attempt = 0; attempt < 6; attempt++) {
        ink = rng.int(0, k - 1)
        word = kind === 'neutral' ? null : kind === 'congruent' ? ink : (ink + rng.int(1, k - 1)) % k
        if (`${word}/${ink}` !== previous) break
      }
      previous = `${word}/${ink}`
      return { kind, word, ink, order: shuffle ? rng.shuffle(identity) : identity, windowMs: params.windowMs, gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.windowMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      return { correct: response !== 'timeout' && response === trial.ink, tag: trial.kind }
    },
  }
}

const name = (index: number) => PALETTE[index].name
export const describeCc = (trial: CcTrial): string => `${trial.word === null ? 'XXXX' : name(trial.word)} printed in ${name(trial.ink)}`

export function summariseColourClash(log: TrialLogEntry<CcTrial, CcResponse>[], level: number): SessionSummary {
  const p = paramsAt(COLOUR_CLASH_PARAMS, level)
  const valid = log.length
  const correct = log.filter(entry => entry.outcome.correct).length
  const rtOf = (entries: typeof log) => entries.filter(entry => entry.outcome.correct && entry.rtMs !== null).map(entry => entry.rtMs as number)
  const medianRt = median(rtOf(log))
  const skill = choiceSkill(correct, valid, Math.round(p.colours))
  const speed = speedFactor(medianRt, p.rtFast, p.rtSlow)
  const expected = expectedTrials(BLOCK_SECONDS.colour_clash, (p.rtFast + p.rtSlow) / 2, p.gapMs)
  const score = speedEmphasisScore(skill, speed, volumeFactor(valid, expected))
  const congruentRt = median(rtOf(log.filter(entry => entry.trial.kind === 'congruent')))
  const incongruentRt = median(rtOf(log.filter(entry => entry.trial.kind === 'incongruent')))
  const incongruentTrials = log.filter(entry => entry.trial.kind === 'incongruent')
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: describeCc(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : name(entry.response),
    correctAnswer: name(entry.trial.ink), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      trials: valid, accuracy: valid ? round3(correct / valid) : 0, median_rt: Math.round(medianRt ?? 0),
      median_rt_congruent: Math.round(congruentRt ?? 0), median_rt_incongruent: Math.round(incongruentRt ?? 0),
      stroop_effect: congruentRt !== undefined && incongruentRt !== undefined ? Math.round(incongruentRt - congruentRt) : 0,
      incongruent_error_rate: incongruentTrials.length ? round3(incongruentTrials.filter(entry => !entry.outcome.correct).length / incongruentTrials.length) : 0,
      anticipations: log.filter(entry => entry.outcome.anticipated).length,
      lapses: log.filter(entry => entry.response === 'timeout').length,
    },
    review,
  }
}

export const colourClashSim: SimPlayer<CcTrial, CcResponse> = {
  correct: trial => trial.ink,
  random: (trial, rng) => trial.order[rng.int(0, trial.order.length - 1)],
}
