/**
 * Deterministic candle-pattern and breakout detectors for Spot the Trap (spec 5.9). Pure: bars in, indices out. All of them work on
 * 5 second bars and are scaled by `vol`, the median 5 second high-low range (the round's volUnit), so a quiet and a wild stretch are judged
 * alike. Each detector has a strict form (a true occurrence) and a loose form; what the loose form finds beyond the strict form is a
 * near miss (the distractors of the pattern hunt).
 */
import type { Bars } from './series'

export type PatternKind = 'inside_break' | 'engulfing' | 'pin_bar' | 'higher_low'
export const PATTERN_KINDS: readonly PatternKind[] = ['inside_break', 'engulfing', 'pin_bar', 'higher_low']
export const PATTERN_LABEL: Record<PatternKind, string> = { inside_break: 'Inside-bar break', engulfing: 'Engulfing candle', pin_bar: 'Pin-bar rejection', higher_low: 'Higher-low sequence' }
export const PATTERN_HELP: Record<PatternKind, string> = {
  inside_break: 'A bar that stays inside the bar before it, then a bar that closes beyond that bigger bar\'s range. Click the breaking bar.',
  engulfing: 'A bar whose body covers the whole body of the bar before it, in the opposite colour. Click the engulfing bar.',
  pin_bar: 'A bar with a long wick and a small body at the end of a move, closing away from the wick. Click the pin bar.',
  higher_low: 'Three swing lows in a row, each higher than the one before. Click the third low.',
}

const body = (bars: Bars, i: number): number => Math.abs(bars.c[i] - bars.o[i])
const range = (bars: Bars, i: number): number => bars.h[i] - bars.l[i]
const up = (bars: Bars, i: number): boolean => bars.c[i] >= bars.o[i]

interface Thresholds { motherRange: number; engulfBody: number; wickBody: number; wickRange: number; extremeBars: number; pivotRise: number }
const STRICT: Thresholds = { motherRange: 1.0, engulfBody: 0.6, wickBody: 2, wickRange: 0.8, extremeBars: 6, pivotRise: 0.25 }
const LOOSE: Thresholds = { motherRange: 0.6, engulfBody: 0.35, wickBody: 1.5, wickRange: 0.5, extremeBars: 4, pivotRise: 0.05 }

function insideBreak(bars: Bars, vol: number, t: Thresholds): number[] {
  const out: number[] = []
  for (let i = 2; i < bars.t.length; i++) {
    const mother = i - 2, inside = i - 1
    if (!(bars.h[inside] < bars.h[mother] && bars.l[inside] > bars.l[mother])) continue
    if (range(bars, mother) < t.motherRange * vol) continue
    if (bars.c[i] > bars.h[mother] || bars.c[i] < bars.l[mother]) out.push(i)
  }
  return out
}

function engulfing(bars: Bars, vol: number, t: Thresholds): number[] {
  const out: number[] = []
  for (let i = 1; i < bars.t.length; i++) {
    if (up(bars, i) === up(bars, i - 1) || body(bars, i) < t.engulfBody * vol || body(bars, i - 1) < 0.2 * vol) continue
    const lowPrev = Math.min(bars.o[i - 1], bars.c[i - 1]), highPrev = Math.max(bars.o[i - 1], bars.c[i - 1])
    if (Math.min(bars.o[i], bars.c[i]) <= lowPrev && Math.max(bars.o[i], bars.c[i]) >= highPrev) out.push(i)
  }
  return out
}

function pinBar(bars: Bars, vol: number, t: Thresholds): number[] {
  const out: number[] = []
  for (let i = t.extremeBars; i < bars.t.length; i++) {
    const b = Math.max(body(bars, i), 0.05 * vol)
    const top = Math.max(bars.o[i], bars.c[i]), bottom = Math.min(bars.o[i], bars.c[i])
    const upper = bars.h[i] - top, lower = bottom - bars.l[i]
    const window = Array.from({ length: t.extremeBars }, (_, k) => i - 1 - k)
    const topsOut = window.every(k => bars.h[i] >= bars.h[k]), bottomsOut = window.every(k => bars.l[i] <= bars.l[k])
    // Rejection of a high: a long upper wick at the highest high of the last bars; of a low: the mirror.
    if (upper >= t.wickBody * b && upper >= t.wickRange * vol && topsOut && lower <= upper / 3) out.push(i)
    else if (lower >= t.wickBody * b && lower >= t.wickRange * vol && bottomsOut && upper <= lower / 3) out.push(i)
  }
  return out
}

function higherLow(bars: Bars, vol: number, t: Thresholds): number[] {
  const pivots: number[] = []
  for (let i = 2; i < bars.t.length - 2; i++) if (bars.l[i] < bars.l[i - 1] && bars.l[i] < bars.l[i - 2] && bars.l[i] <= bars.l[i + 1] && bars.l[i] <= bars.l[i + 2]) pivots.push(i)
  const out: number[] = []
  for (let k = 2; k < pivots.length; k++) {
    const a = bars.l[pivots[k - 2]], b = bars.l[pivots[k - 1]], c = bars.l[pivots[k]]
    if (b - a >= t.pivotRise * vol && c - b >= t.pivotRise * vol) out.push(pivots[k])
  }
  return out
}

const DETECTORS: Record<PatternKind, (bars: Bars, vol: number, t: Thresholds) => number[]> = { inside_break: insideBreak, engulfing, pin_bar: pinBar, higher_low: higherLow }

/** Indices of the bars that complete the pattern. `loose` finds more (strict ones included). */
export function detectPattern(kind: PatternKind, bars: Bars, vol: number, loose = false): number[] {
  if (!(vol > 0) || bars.t.length < 3) return []
  return DETECTORS[kind](bars, vol, loose ? LOOSE : STRICT)
}

/** Near misses: found by the loose form, not within a bar of a true occurrence. */
export function nearMisses(kind: PatternKind, bars: Bars, vol: number): number[] {
  const strict = detectPattern(kind, bars, vol, false)
  return detectPattern(kind, bars, vol, true).filter(i => !strict.some(s => Math.abs(s - i) <= 1))
}

export interface HuntScore { precision: number; recall: number; f1: number; matched: number }

/**
 * F1 of clicked bars against true occurrences, a click counting for an occurrence within `tolerance` bars (each occurrence and each click is used
 * once). No clicks and no occurrences is a perfect 1; no clicks with occurrences, or clicks with none, is 0.
 */
export function huntF1(clicks: number[], truth: number[], tolerance = 1): HuntScore {
  if (!clicks.length && !truth.length) return { precision: 1, recall: 1, f1: 1, matched: 0 }
  const free = [...truth]
  let matched = 0
  for (const click of [...clicks].sort((a, b) => a - b)) {
    let best = -1
    free.forEach((t, k) => { if (Math.abs(t - click) <= tolerance && (best < 0 || Math.abs(t - click) < Math.abs(free[best] - click))) best = k })
    if (best >= 0) { matched += 1; free.splice(best, 1) }
  }
  const precision = clicks.length ? matched / clicks.length : 0
  const recall = truth.length ? matched / truth.length : 0
  return { precision, recall, f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0, matched }
}

// ---------------------------------------------------------------------------------------------------------- breakouts

export interface Breakout { index: number; direction: 1 | -1; level: number }

/**
 * Bars that close beyond the highest high (or lowest low) of the previous `lookback` bars for the first time (the bar before did not). The
 * level is that high or low. `lookback` bars are needed before a breakout.
 */
export function findBreakouts(bars: Bars, lookback: number): Breakout[] {
  const out: Breakout[] = []
  for (let i = lookback; i < bars.t.length; i++) {
    let high = Number.NEGATIVE_INFINITY, low = Number.POSITIVE_INFINITY
    for (let k = i - lookback; k < i; k++) { high = Math.max(high, bars.h[k]); low = Math.min(low, bars.l[k]) }
    if (bars.c[i] > high && bars.c[i - 1] <= high) out.push({ index: i, direction: 1, level: high })
    else if (bars.c[i] < low && bars.c[i - 1] >= low) out.push({ index: i, direction: -1, level: low })
  }
  return out
}

export interface BreakoutTruth {
  real: boolean
  /** The furthest the price got beyond the level, and the first bar it was extended / came back (offsets after the breakout bar; -1 = never). */
  maxExtension: number
  extendedAt: number
  returnedAt: number
}

/**
 * REAL if the price extends `ext` points beyond the level before it returns `ret` points inside it, within `horizonBars` bars after the breakout;
 * otherwise FAKE (it never extended, or it fell back first). In the same bar the extension (the bar's best price) counts as first.
 */
export function breakoutTruth(bars: Bars, breakout: Breakout, ext: number, ret: number, horizonBars: number): BreakoutTruth {
  const { direction, level } = breakout
  let maxExtension = 0, extendedAt = -1, returnedAt = -1
  const end = Math.min(bars.t.length, breakout.index + 1 + horizonBars)
  for (let j = breakout.index + 1; j < end; j++) {
    const best = direction === 1 ? bars.h[j] - level : level - bars.l[j]
    const close = direction === 1 ? level - bars.c[j] : bars.c[j] - level
    maxExtension = Math.max(maxExtension, best)
    if (extendedAt < 0 && best >= ext) extendedAt = j - breakout.index
    if (returnedAt < 0 && close >= ret) returnedAt = j - breakout.index
  }
  const real = extendedAt >= 0 && (returnedAt < 0 || extendedAt <= returnedAt)
  return { real, maxExtension, extendedAt, returnedAt }
}
