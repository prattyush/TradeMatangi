/** Needle Finder (Attention, spec 17.5 #8): find the one odd item and click it, or say it is not there. Pure engine. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { NEEDLE_FINDER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

/** Palette indices: RED target, BLUE and ORANGE distractors, GREEN the extra distractor (see `ui/palette.ts`). */
const RED = 3, BLUE = 1, ORANGE = 0, GREEN = 2
export interface NfItem { x: number; y: number; colour: number; /** 'v' vertical bar, 'h' horizontal bar */ orient: 'v' | 'h' }
export interface NfTrial {
  items: NfItem[]
  /** Index of the target in `items`, or -1 when it is absent. */
  target: number
  setSize: number
  mode: 0 | 1 | 2
  limitMs: number
  gapMs: number
}
export type NfResponse = { type: 'click'; index: number } | { type: 'absent' }

/** The arena is 100 wide and 70 high (units, scaled by the view). */
export const NF_WIDTH = 100
export const NF_HEIGHT = 70

export function createNeedleEngine(params: Record<string, number>, rng: Rng): TrialEngine<NfTrial, NfResponse> {
  const mode = Math.min(2, Math.max(0, Math.round(params.mode))) as 0 | 1 | 2
  const absent = Math.round((params.absentPct * 20) / 100)
  const baseSize = Math.round(params.setSize)
  // Set size varies inside a block (half, three quarters, full) so a search slope can be estimated.
  const sizes = [Math.max(4, Math.round(baseSize * 0.5)), Math.max(4, Math.round(baseSize * 0.75)), baseSize]
  let sizeQueue: number[] = []
  let absentQueue: boolean[] = []
  let issued = 0
  const total = ROUND_COUNTS.needle_finder

  const distractor = (i: number): { colour: number; orient: 'v' | 'h' } => {
    if (mode === 0) return { colour: BLUE, orient: 'v' }
    if (mode === 1) return i % 2 ? { colour: RED, orient: 'h' } : { colour: BLUE, orient: 'v' }
    return [{ colour: RED, orient: 'h' }, { colour: BLUE, orient: 'v' }, { colour: ORANGE, orient: 'h' }, { colour: GREEN, orient: 'v' }][i % 4]
  }

  return {
    next() {
      if (issued >= total) return null
      if (!absentQueue.length) absentQueue = rng.shuffle([...Array(absent).fill(true), ...Array(Math.max(0, total - absent)).fill(false)])
      if (!sizeQueue.length) sizeQueue = rng.shuffle(sizes)
      const isAbsent = absentQueue.pop() as boolean
      const setSize = sizeQueue.pop() as number
      // Jittered grid: every item gets its own cell, nudged by up to `jitter` of the cell size.
      const cols = Math.ceil(Math.sqrt((setSize * NF_WIDTH) / NF_HEIGHT))
      const rows = Math.ceil(setSize / cols)
      const cw = NF_WIDTH / cols, ch = NF_HEIGHT / rows
      const cells = rng.shuffle(Array.from({ length: cols * rows }, (_, i) => i)).slice(0, setSize)
      const items: NfItem[] = cells.map((cell, i) => {
        const { colour, orient } = distractor(i)
        const jx = (rng.next() - 0.5) * 2 * params.jitter * cw * 0.5
        const jy = (rng.next() - 0.5) * 2 * params.jitter * ch * 0.5
        return { x: (cell % cols) * cw + cw / 2 + jx, y: Math.floor(cell / cols) * ch + ch / 2 + jy, colour, orient }
      })
      let target = -1
      if (!isAbsent) {
        target = rng.int(0, setSize - 1)
        items[target] = { ...items[target], colour: RED, orient: 'v' } // red vertical bar: the needle
      }
      issued += 1
      return { items, target, setSize, mode, limitMs: params.limitMs, gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.limitMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      if (response.type === 'absent') return trial.target === -1 ? { correct: true, tag: 'cr' } : { correct: false, tag: 'miss' }
      if (trial.target === -1) return { correct: false, tag: 'fa' }
      return response.index === trial.target ? { correct: true, tag: 'hit' } : { correct: false, tag: 'wrong' }
    },
    progress: () => ({ trial: issued, of: total }),
  }
}

export const correctNf = (trial: NfTrial): NfResponse => (trial.target === -1 ? { type: 'absent' } : { type: 'click', index: trial.target })
const describeNf = (trial: NfTrial) => `${trial.setSize} items, ${trial.target === -1 ? 'target absent' : 'target present'} (${['one colour differs', 'colour and orientation', 'colour, orientation, extra distractors'][trial.mode]})`
const describeResponse = (response: NfResponse | 'timeout') => (response === 'timeout' ? 'no answer' : response.type === 'absent' ? 'not there' : `clicked item ${response.index + 1}`)

/** Least-squares slope of search time against set size, in ms per item; 0 when there is too little spread to say. */
export function searchSlope(points: Array<{ size: number; ms: number }>): number {
  if (points.length < 6 || new Set(points.map(p => p.size)).size < 2) return 0
  const n = points.length
  const mx = points.reduce((s, p) => s + p.size, 0) / n, my = points.reduce((s, p) => s + p.ms, 0) / n
  const sxx = points.reduce((s, p) => s + (p.size - mx) ** 2, 0)
  return sxx === 0 ? 0 : points.reduce((s, p) => s + (p.size - mx) * (p.ms - my), 0) / sxx
}

export function summariseNeedleFinder(log: TrialLogEntry<NfTrial, NfResponse>[], level: number): SessionSummary {
  const p = paramsAt(NEEDLE_FINDER_PARAMS, level)
  const present = log.filter(entry => entry.trial.target !== -1)
  const absent = log.filter(entry => entry.trial.target === -1)
  const hits = present.filter(entry => entry.outcome.tag === 'hit').length
  const falseAlarms = absent.filter(entry => entry.outcome.tag === 'fa').length
  // Chance-corrected like a detection task: saying "absent" every time, or clicking at random, scores nothing.
  const skill = present.length && absent.length ? clamp01(hits / present.length - falseAlarms / absent.length) : present.length ? clamp01(hits / present.length) : 0
  const correct = log.filter(entry => entry.outcome.correct)
  const speedOf = (entry: typeof log[number]) => clamp01(1 - (entry.rtMs ?? p.limitMs) / p.limitMs)
  const meanBonus = correct.length ? correct.reduce((s, entry) => s + 0.6 + 0.4 * speedOf(entry), 0) / correct.length : 0
  const hitEntries = present.filter(entry => entry.outcome.tag === 'hit' && entry.rtMs !== null)
  const medianTime = median(hitEntries.map(entry => entry.rtMs as number))
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: describeNf(entry.trial), answered: describeResponse(entry.response), correctAnswer: entry.trial.target === -1 ? 'not there' : `item ${entry.trial.target + 1}`,
    correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: toSessionScore(100 * skill * meanBonus),
    stats: {
      trials: log.length, accuracy: log.length ? round3(correct.length / log.length) : 0, median_search_ms: Math.round(medianTime ?? 0),
      search_slope_ms_per_item: Math.round(searchSlope(hitEntries.map(entry => ({ size: entry.trial.setSize, ms: entry.rtMs as number })))),
      absent_accuracy: absent.length ? round3(absent.filter(entry => entry.outcome.correct).length / absent.length) : 0,
      mode: Math.round(p.mode),
    },
    review,
  }
}

export const needleFinderSim: SimPlayer<NfTrial, NfResponse> = {
  correct: correctNf,
  random: (trial, rng) => (rng.chance(0.5) ? { type: 'absent' } : { type: 'click', index: rng.int(0, trial.items.length - 1) }),
}

