/** Quick Match (Speed, spec 17.5 #1): two items, press S for same and D for different. Pure engine, scoring and sim profile. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, QUICK_MATCH_PARAMS, UNTIL_ANSWERED_MS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, expectedTrials, round3, speedEmphasisScore, speedFactor, volumeFactor } from '../../engine/scoringBrain'
import { PALETTE } from '../../ui/palette'
import type { SimPlayer } from '../../engine/simPlayers'


export type QmResponse = 'same' | 'different'
export type QmFeature = 'none' | 'colour' | 'shape' | 'size' | 'mirror'

/** shape 0 is a circle; 1-5 are irregular polygons (none is mirror-symmetric, so a mirrored copy really is different). */
export interface QmItem { shape: number; colour: number; scale: number; rotation: number; mirrored: boolean }
export interface QmTrial {
  kind: 0 | 1 | 2
  left: QmItem
  right: QmItem
  same: boolean
  /** The main way a "different" pair differs (for the errors-by-feature stat). */
  feature: QmFeature
  vertical: boolean
  displayMs: number | null
  windowMs: number
  gapMs: number
}

const BIG_SCALES = [0.7, 1.35]
const SMALL_SCALES = [0.88, 1.14]

export function createQuickMatchEngine(params: Record<string, number>, rng: Rng): TrialEngine<QmTrial, QmResponse> {
  const kind = Math.min(2, Math.max(0, Math.round(params.kind))) as 0 | 1 | 2
  const similarity = params.similarity
  const displayMs = params.displayMs >= UNTIL_ANSWERED_MS ? null : params.displayMs
  // Same and different are exactly balanced in every run of ten trials.
  let balance: boolean[] = []
  const nextSame = () => {
    if (!balance.length) balance = rng.shuffle([true, true, true, true, true, false, false, false, false, false])
    return balance.pop() as boolean
  }
  const features: QmFeature[] = kind === 0 ? ['colour', 'size'] : kind === 1 ? ['colour', 'shape', 'size'] : ['mirror', 'colour', 'shape', 'size']

  const baseItem = (): QmItem => ({
    shape: kind === 0 ? 0 : rng.int(1, 5), colour: rng.int(0, PALETTE.length - 1), scale: 1, rotation: 0, mirrored: false,
  })
  const otherColour = (current: number) => (current + rng.int(1, PALETTE.length - 1)) % PALETTE.length
  const otherShape = (current: number) => 1 + ((current - 1 + rng.int(1, 4)) % 5)

  const differ = (item: QmItem, feature: QmFeature): QmItem => {
    switch (feature) {
      case 'colour': return { ...item, colour: otherColour(item.colour) }
      case 'shape': return { ...item, shape: otherShape(item.shape) }
      case 'size': return { ...item, scale: rng.pick(similarity >= 0.8 ? SMALL_SCALES : BIG_SCALES) }
      case 'mirror': return { ...item, mirrored: !item.mirrored }
      default: return item
    }
  }

  return {
    next() {
      const same = nextSame()
      const left = baseItem()
      let right: QmItem = { ...left }
      let feature: QmFeature = 'none'
      if (!same) {
        // At kind 2 half of the "different" pairs are mirror images, the signature difficulty of that stage.
        const primary: QmFeature = kind === 2 && rng.chance(0.5) ? 'mirror' : rng.pick(features)
        feature = primary
        right = differ(right, primary)
        if (similarity < 0.5) {
          const rest = features.filter(f => f !== primary)
          if (rest.length) right = differ(right, rng.pick(rest))
        }
      }
      if (kind === 2) { left.rotation = rng.int(0, 359); right.rotation = rng.int(0, 359) }
      return {
        kind, left, right, same, feature, vertical: kind >= 1 && rng.chance(0.5),
        displayMs, windowMs: params.windowMs, gapMs: params.gapMs,
      }
    },
    timing: (trial): TrialTiming => ({ displayMs: trial.displayMs, windowMs: trial.windowMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      return { correct: response !== 'timeout' && (response === 'same') === trial.same }
    },
  }
}

export const correctQm = (trial: QmTrial): QmResponse => (trial.same ? 'same' : 'different')

const SHAPE_NAME = ['circle', 'pentagon-flag', 'hook', 'arrowhead', 'wedge', 'boot']
const itemText = (item: QmItem) =>
  `${PALETTE[item.colour].name.toLowerCase()} ${SHAPE_NAME[item.shape] ?? 'shape'}${item.mirrored ? ' (mirrored)' : ''}${item.scale !== 1 ? ` (size ${item.scale})` : ''}`
export const describeQm = (trial: QmTrial): string => `${itemText(trial.left)}  |  ${itemText(trial.right)}`

export function summariseQuickMatch(log: TrialLogEntry<QmTrial, QmResponse>[], level: number): SessionSummary {
  const p = paramsAt(QUICK_MATCH_PARAMS, level)
  const valid = log.length
  const correct = log.filter(entry => entry.outcome.correct).length
  const rtOf = (entries: typeof log) => entries.filter(entry => entry.outcome.correct && entry.rtMs !== null).map(entry => entry.rtMs as number)
  const medianRt = median(rtOf(log))
  const skill = choiceSkill(correct, valid, 2)
  const speed = speedFactor(medianRt, p.rtFast, p.rtSlow)
  const expected = expectedTrials(BLOCK_SECONDS.quick_match, (p.rtFast + p.rtSlow) / 2, p.gapMs)
  const score = speedEmphasisScore(skill, speed, volumeFactor(valid, expected))
  const sameRt = median(rtOf(log.filter(entry => entry.trial.same)))
  const diffRt = median(rtOf(log.filter(entry => !entry.trial.same)))
  const errors = (feature: QmFeature) => log.filter(entry => !entry.outcome.correct && entry.trial.feature === feature).length
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: describeQm(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : entry.response,
    correctAnswer: correctQm(entry.trial), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      trials: valid, accuracy: valid ? round3(correct / valid) : 0, median_rt: Math.round(medianRt ?? 0),
      rt_gap_diff_minus_same: sameRt !== undefined && diffRt !== undefined ? Math.round(diffRt - sameRt) : 0,
      err_colour: errors('colour'), err_shape: errors('shape'), err_size: errors('size'), err_mirror: errors('mirror'),
      anticipations: log.filter(entry => entry.outcome.anticipated).length,
      lapses: log.filter(entry => entry.response === 'timeout').length,
    },
    review,
  }
}

export const quickMatchSim: SimPlayer<QmTrial, QmResponse> = {
  correct: correctQm,
  random: (_trial, rng) => (rng.chance(0.5) ? 'same' : 'different'),
}

