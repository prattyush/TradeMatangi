/** N-Back Stream (Memory, spec 17.5 #6): press when the item equals the one n steps back. Pure engine, scoring, sim. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { N_BACK_PARAMS } from '../../config/difficulty.brain'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

export const NB_LETTERS = ['C', 'H', 'K', 'L', 'Q', 'R', 'S', 'T'] as const
export const NB_CELLS = 9
export type NbKind = 'warmup' | 'match' | 'lure' | 'normal'
/** Which key was pressed, and when (ms after the item appeared). In dual mode both can be pressed. */
export type NbPress = 'letter' | 'pos'
/** Reaction time of each press during the item, or `null` when that key was not pressed. */
export interface NbResponse { letter: number | null; pos: number | null }

export interface NbTrial {
  index: number
  n: number
  dual: boolean
  letter: number
  pos: number
  letterKind: NbKind
  posKind: NbKind
  itemMs: number
  blankMs: number
}

const CHUNK = 20

export function createNBackEngine(params: Record<string, number>, rng: Rng): TrialEngine<NbTrial, NbResponse> {
  const n = Math.max(1, Math.round(params.n))
  const dual = params.dual >= 1
  const matches = Math.round((params.matchPct * CHUNK) / 100)
  const lures = Math.round((params.lurePct * CHUNK) / 100)
  const histories = { letter: [] as number[], pos: [] as number[] }
  const queues = { letter: [] as NbKind[], pos: [] as NbKind[] }
  let index = 0

  const draw = (modality: NbPress, alphabet: number): { item: number; kind: NbKind } => {
    const history = histories[modality]
    if (index < n) return { item: rng.int(0, alphabet - 1), kind: 'warmup' }
    if (!queues[modality].length) {
      queues[modality] = rng.shuffle<NbKind>([...Array(matches).fill('match'), ...Array(lures).fill('lure'), ...Array(Math.max(0, CHUNK - matches - lures)).fill('normal')])
    }
    const wanted = queues[modality].pop() as NbKind
    const target = history[index - n]
    // Lures repeat an item one step nearer or further than n (a near miss that must be rejected).
    const nearMisses = [history[index - n - 1], n > 1 ? history[index - n + 1] : undefined].filter((v): v is number => v !== undefined && v !== target)
    if (wanted === 'match') return { item: target, kind: 'match' }
    if (wanted === 'lure' && nearMisses.length) return { item: rng.pick(nearMisses), kind: 'lure' }
    let item = rng.int(0, alphabet - 1)
    for (let attempt = 0; attempt < 30 && (item === target || nearMisses.includes(item)); attempt++) item = rng.int(0, alphabet - 1)
    return { item, kind: 'normal' }
  }

  return {
    next() {
      const letter = draw('letter', NB_LETTERS.length)
      const pos = dual ? draw('pos', NB_CELLS) : { item: 4, kind: 'warmup' as NbKind }
      histories.letter.push(letter.item)
      histories.pos.push(pos.item)
      const trial: NbTrial = {
        index, n, dual, letter: letter.item, pos: pos.item, letterKind: letter.kind, posKind: dual ? pos.kind : 'warmup',
        itemMs: params.itemMs, blankMs: params.blankMs,
      }
      index += 1
      return trial
    },
    timing: (trial): TrialTiming => ({ displayMs: trial.itemMs - trial.blankMs, windowMs: trial.itemMs, gapMs: 0, fixedCadence: true }),
    evaluate(trial, response): TrialOutcome {
      const pressed: NbResponse = response === 'timeout' ? { letter: null, pos: null } : response
      const tag = (kind: NbKind, press: number | null): string =>
        kind === 'warmup' ? 'skip' : kind === 'match' ? (press !== null ? 'hit' : 'miss') : kind === 'lure' ? (press !== null ? 'lfa' : 'lcr') : press !== null ? 'fa' : 'cr'
      const letterTag = tag(trial.letterKind, pressed.letter)
      const posTag = trial.dual ? tag(trial.posKind, pressed.pos) : null
      const good = (t: string | null) => t === null || t === 'skip' || t === 'hit' || t === 'cr' || t === 'lcr'
      return { correct: good(letterTag) && good(posTag), tag: posTag === null ? letterTag : `${letterTag}|${posTag}` }
    },
  }
}

export const nbItemText = (trial: NbTrial): string => `${NB_LETTERS[trial.letter]}${trial.dual ? ` at cell ${trial.pos + 1}` : ''}`

export function summariseNBack(log: TrialLogEntry<NbTrial, NbResponse>[], level: number): SessionSummary {
  const p = paramsAt(N_BACK_PARAMS, level)
  const counts = { hit: 0, miss: 0, fa: 0, cr: 0, lfa: 0, lcr: 0 }
  let scored = 0
  for (const entry of log) {
    for (const tag of (entry.outcome.tag ?? 'skip').split('|')) {
      if (tag in counts) { counts[tag as keyof typeof counts] += 1 }
    }
    if (entry.trial.index >= entry.trial.n) scored += 1
  }
  const matchTrials = counts.hit + counts.miss
  const nonMatch = counts.fa + counts.cr + counts.lfa + counts.lcr
  const hitRate = matchTrials ? counts.hit / matchTrials : 0
  const falseAlarmRate = nonMatch ? (counts.fa + counts.lfa) / nonMatch : 0
  const lureTrials = counts.lfa + counts.lcr
  const review: ReviewRow[] = log.slice(0, 250).map(entry => {
    const response = entry.response === 'timeout' ? { letter: null, pos: null } : entry.response
    const pressed = [response.letter !== null ? 'letter' : '', response.pos !== null ? 'position' : ''].filter(Boolean).join(' + ')
    const wants = [entry.trial.letterKind === 'match' ? 'letter' : '', entry.trial.dual && entry.trial.posKind === 'match' ? 'position' : ''].filter(Boolean).join(' + ')
    return { n: entry.n, shown: `${nbItemText(entry.trial)} (${p.n}-back${entry.trial.index < entry.trial.n ? ', warm-up' : ''})`, answered: pressed || 'no press', correctAnswer: wants || 'no press', correct: entry.outcome.correct, rtMs: response.letter ?? response.pos }
  })
  return {
    score: toSessionScore(100 * clamp01(hitRate - falseAlarmRate)),
    stats: {
      trials: scored, hit_rate: round3(hitRate), false_alarm_rate: round3(falseAlarmRate),
      lure_false_alarm_rate: lureTrials ? round3(counts.lfa / lureTrials) : 0, n_reached: Math.round(p.n),
    },
    review,
  }
}

const RT = 450
const matchOf = (trial: NbTrial): NbResponse => ({ letter: trial.letterKind === 'match' ? RT : null, pos: trial.dual && trial.posKind === 'match' ? RT : null })
export const nBackSim: SimPlayer<NbTrial, NbResponse> = {
  correct: matchOf,
  random: (trial, rng) => ({ letter: rng.chance(0.5) ? RT : null, pos: trial.dual && rng.chance(0.5) ? RT : null }),
  alwaysPress: trial => ({ letter: RT, pos: trial.dual ? RT : null }),
  neverPress: () => ({ letter: null, pos: null }),
}

