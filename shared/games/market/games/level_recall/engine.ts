/**
 * Level Recall (spec 5.6): hold the day's key levels in mind without staring at the chart. The levels are on screen for a few seconds, then
 * the chart goes and the player places each named level on a blank price ladder; the error is scored in the day's volUnits. From level 10 every
 * third round is a swing sequence: study the last six swing points, then say whether each was higher or lower than the one before.
 *
 * Real prices are shown here (levels are absolute), but the symbol and the day stay hidden until the result.
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import { hashSeed, type Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { LEVEL_RECALL } from '../../config/difficulty.market'
import { computeLevels, dayVolUnit, LEVEL_KINDS, ROUND_STEP, swingPoints, type LevelKind, type Swing } from '../../engine/levels'
import { barsFromWindow, type Bars, type WindowData } from '../../engine/series'
import { daysBetween } from '../../../core/dates'
import { windowId, type Availability, pickWindow } from '../../engine/windows'
import type { MarketData } from '../../data/marketData'

export type RoundMode = 'levels' | 'sequence'

export interface ShownLevel { kind: LevelKind; value: number; asked: boolean }

export interface LevelRound {
  id: string
  symbol: string
  date: string
  priorDate: string
  /** The second of the day the round is at: nothing after it is used. */
  roundSec: number
  mode: RoundMode
  price: number
  volDay: number
  /** Mode `levels`: everything shown during the study, and the asked ones in the order they are prompted. */
  levels: ShownLevel[]
  prompts: LevelKind[]
  /** Mode `sequence`: the last six swing points. */
  swings: Swing[]
  prior: Bars
  today: Bars
  /** The price range of the ladder. */
  axis: { lo: number; hi: number }
}

export interface RoundSpec { id: string; symbol: string; date: string; priorDate: string; roundSec: number; levelCount: number; distractors: number; mode: RoundMode }

const cut = (bars: Bars, before: number): Bars => {
  const n = bars.t.filter(t => t < before).length
  return { t: bars.t.slice(0, n), o: bars.o.slice(0, n), h: bars.h.slice(0, n), l: bars.l.slice(0, n), c: bars.c.slice(0, n) }
}

/** The round for two days of 60 second windows, or null when the data cannot make it (gaps, levels too close together, too few swings). */
export function buildLevelRound(priorWindow: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, todayWindow: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: RoundSpec, rng: Rng): LevelRound | null {
  const prior = barsFromWindow(priorWindow)
  const today = cut(barsFromWindow(todayWindow), spec.roundSec)
  const expectedToday = (spec.roundSec - LEVEL_RECALL.openSec) / 60
  if (prior.t.length < 250 || today.t.length < expectedToday * 0.8) return null
  const levels = computeLevels(prior, today, LEVEL_RECALL.openSec, ROUND_STEP[spec.symbol] ?? 100)
  if (!levels) return null
  const volDay = dayVolUnit(prior, today, levels.price * LEVEL_RECALL.floorUnits)
  const lo = Math.min(...prior.l, ...today.l), hi = Math.max(...prior.h, ...today.h)
  const pad = (hi - lo) * LEVEL_RECALL.axisPad
  const base = { id: spec.id, symbol: spec.symbol, date: spec.date, priorDate: spec.priorDate, roundSec: spec.roundSec, mode: spec.mode, price: levels.price, volDay, prior, today, axis: { lo: lo - pad, hi: hi + pad } }
  if (spec.mode === 'sequence') {
    const all: Bars = { t: [...prior.t.map(t => t - 86_400), ...today.t], o: [...prior.o, ...today.o], h: [...prior.h, ...today.h], l: [...prior.l, ...today.l], c: [...prior.c, ...today.c] }
    const swings = swingPoints(all, LEVEL_RECALL.swingThreshold * volDay).slice(-LEVEL_RECALL.swings)
    if (swings.length < LEVEL_RECALL.swings) return null
    return { ...base, levels: [], prompts: [], swings }
  }
  // Levels: shuffle the kinds, keep the ones that are far enough from those already kept.
  const separation = Math.max(LEVEL_RECALL.minSeparation * volDay, LEVEL_RECALL.minAxisShare * (base.axis.hi - base.axis.lo))
  const kept: ShownLevel[] = []
  for (const kind of rng.shuffle(LEVEL_KINDS)) {
    const value = levels.values[kind]
    if (kept.some(k => Math.abs(k.value - value) < separation)) continue
    kept.push({ kind, value, asked: kept.filter(k => k.asked).length < spec.levelCount })
  }
  const asked = kept.filter(k => k.asked)
  if (asked.length < Math.min(3, spec.levelCount)) return null
  const shown = kept.filter(k => k.asked || kept.filter(x => !x.asked).indexOf(k) < spec.distractors)
  return { ...base, levels: shown, prompts: rng.shuffle(asked.map(k => k.kind)), swings: [] }
}

export interface LevelError { kind: LevelKind; placed: number | null; truth: number; errorPts: number | null; errorUnits: number | null; score: number }

/** `levelScore = clamp(1 - error / (tolMult x volDay), 0, 1)`; a level that was not placed scores 0. `roundScore` is the mean over the asked levels. */
export function scoreLevels(round: LevelRound, placed: Partial<Record<LevelKind, number>>, tolMult: number): { errors: LevelError[]; roundScore: number } {
  const errors = round.levels.filter(l => l.asked).map(l => {
    const p = placed[l.kind]
    if (p === undefined || !Number.isFinite(p)) return { kind: l.kind, placed: null, truth: l.value, errorPts: null, errorUnits: null, score: 0 }
    const errorPts = Math.abs(p - l.value)
    return { kind: l.kind, placed: p, truth: l.value, errorPts, errorUnits: errorPts / round.volDay, score: clamp(1 - errorPts / (tolMult * round.volDay), 0, 1) }
  })
  return { errors, roundScore: errors.length ? errors.reduce((s, e) => s + e.score, 0) / errors.length : 0 }
}

/** The five questions of a swing sequence: is swing k+1 higher than swing k? */
export const sequenceTruth = (swings: Swing[]): boolean[] => swings.slice(1).map((s, i) => s.price > swings[i].price)

/** Accuracy corrected for chance (a guess is right half the time): `(accuracy - 0.5) / 0.5`, 0 to 1; an unanswered question counts as wrong. */
export function scoreSequence(swings: Swing[], answers: Array<boolean | null>): { correct: number; total: number; roundScore: number } {
  const truth = sequenceTruth(swings)
  const correct = truth.filter((t, i) => answers[i] === t).length
  return { correct, total: truth.length, roundScore: truth.length ? clamp((correct / truth.length - 0.5) / 0.5, 0, 1) : 0 }
}

export interface RoundResult { mode: RoundMode; roundScore: number; errors: LevelError[]; sequence?: { correct: number; total: number } }

const round2 = (value: number): number => Math.round(value * 100) / 100

/** `SessionScore = 100 x mean(roundScore)`; stats: the mean error in volUnits, the error of each level type, and the sequence accuracy. */
export function summariseLevels(results: RoundResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((s, r) => s + r.roundScore, 0) / n : 0
  const placed = results.flatMap(r => r.errors).filter(e => e.errorUnits !== null)
  const stats: Record<string, number> = {
    rounds: n,
    mean_error_units: placed.length ? round2(placed.reduce((s, e) => s + (e.errorUnits ?? 0), 0) / placed.length) : 0,
    unplaced: results.flatMap(r => r.errors).filter(e => e.placed === null).length,
  }
  for (const kind of LEVEL_KINDS) {
    const rows = placed.filter(e => e.kind === kind)
    if (rows.length) stats[`err_${kind}`] = round2(rows.reduce((s, e) => s + (e.errorUnits ?? 0), 0) / rows.length)
  }
  const seq = results.filter(r => r.sequence)
  if (seq.length) stats.sequence_accuracy = round2((seq.reduce((s, r) => s + (r.sequence?.correct ?? 0), 0) / seq.reduce((s, r) => s + (r.sequence?.total ?? 1), 0)) * 100)
  return { score: toSessionScore(100 * mean), stats }
}

// ---------------------------------------------------------------------------------------------------------- the source

/** Availability restricted to days whose previous listed day is close enough to be "the day before", with that day. */
export function withPriorDays(availability: Availability): { eligible: Availability; priorOf: Map<string, string> } {
  const priorOf = new Map<string, string>()
  const symbols: Availability['symbols'] = {}
  for (const [symbol, entry] of Object.entries(availability.symbols ?? {})) {
    const dates = [...(entry.dates ?? [])].sort()
    const ok: string[] = []
    for (let i = 1; i < dates.length; i++) {
      const gap = daysBetween(dates[i - 1], dates[i])
      if (gap >= 1 && gap <= LEVEL_RECALL.maxPriorGapDays) { ok.push(dates[i]); priorOf.set(`${symbol}|${dates[i]}`, dates[i - 1]) }
    }
    symbols[symbol] = { ...entry, dates: ok }
  }
  return { eligible: { ...availability, symbols }, priorOf }
}

export type NextLevelRound = { ok: true; round: LevelRound } | { ok: false; reason: 'no_data' | 'cancelled' }

export function createLevelSource(deps: {
  rng: Rng
  availability: Availability
  data: Pick<MarketData, 'window'>
  seen: ReadonlySet<string>
  onUsed?: (id: string) => void
  maxFailures?: number
}): { next(params: { levelCount: number; distractors: number; mode: RoundMode }, signal?: AbortSignal): Promise<NextLevelRound> } {
  const { eligible, priorOf } = withPriorDays(deps.availability)
  const used = new Set<string>()
  const maxFailures = deps.maxFailures ?? 3
  return {
    async next(params, signal) {
      let failures = 0
      while (failures < maxFailures) {
        if (signal?.aborted) return { ok: false, reason: 'cancelled' }
        const pick = pickWindow(deps.rng, eligible, { preSec: 3600, postSec: 3600, avoidOpenSec: 0, avoidCloseSec: 300 }, deps.seen, used)
        const priorDate = pick ? priorOf.get(`${pick.symbol}|${pick.date}`) : undefined
        if (!pick || !priorDate) return { ok: false, reason: 'no_data' }
        used.add(pick.id)
        try {
          const day = { startSec: 0, durationSec: 86_400, intervalSeconds: 60 as const }
          const [prior, today] = await Promise.all([deps.data.window({ symbol: pick.symbol, date: priorDate, ...day }, signal), deps.data.window({ symbol: pick.symbol, date: pick.date, ...day }, signal)])
          const round = buildLevelRound(prior, today, { id: windowId(pick.symbol, pick.date, pick.decisionSec), symbol: pick.symbol, date: pick.date, priorDate, roundSec: pick.decisionSec, mode: params.mode, levelCount: params.levelCount, distractors: params.distractors }, deps.rng)
          if (!round) { failures += 1; continue }
          deps.onUsed?.(pick.id)
          return { ok: true, round }
        } catch (error) {
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return { ok: false, reason: 'cancelled' }
          failures += 1
        }
      }
      return { ok: false, reason: 'no_data' }
    },
  }
}

/** Whether a round of the session is the swing sequence: from level 10, every third one. */
export const isSequenceRound = (index: number, sequenceOn: number): boolean => sequenceOn >= 1 && index % 3 === 2

/** A stable seed for a round's own shuffles (the order the levels are prompted in). */
export const roundSeed = (id: string): number => hashSeed(`level_recall|${id}`)
