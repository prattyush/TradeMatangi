/**
 * Risk Calculator (spec 5.4): instant, correct risk arithmetic for options scalps. Pure and seeded; the numbers are generated
 * here, nothing comes from the market except the lot size (fetched once from `/availability`, with a fallback so the game
 * works offline). Each question carries its answer, the tolerance of an exact answer, how far off a "close" one may be, and a
 * working line shown afterwards.
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { RISK_CALCULATOR } from '../../config/difficulty.market'

export type QuestionType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export const QUESTION_TYPES: readonly QuestionType[] = [1, 2, 3, 4, 5, 6, 7, 8]
export const TYPE_LABEL: Record<QuestionType, string> = {
  1: 'Rupee risk', 2: 'Reward to risk', 3: 'Breakeven', 4: 'Lots for a budget', 5: 'Capital at risk',
  6: 'Option move', 7: 'Averaging', 8: 'Two-step sizing',
}

export const DEFAULT_LOT_SIZE = 65

export interface Question {
  type: QuestionType
  prompt: string
  /** Shown beside the input ("₹", "%", "pts", "lots", "R"). */
  unit: string
  answer: number
  /** An answer within this of `answer` is correct (the display rounding). */
  exactTol: number
  /** An answer within this share of `answer` earns the close credit; 0 means no close credit. */
  closeRel: number
  working: string
  steps: number
}

export interface QuestionParams { ugliness: number; lotsMax: number; maxSteps: number; typePool: number }
export interface QuestionContext { lotSize: number }

const round2 = (value: number): number => Math.round(value * 100) / 100
const rupees = (value: number): string => `₹${Math.round(value).toLocaleString('en-IN')}`
const pts = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, ''))

/** A number between `lo` and `hi` on a grid: round numbers at ugliness 0, 0.5 steps in the middle, 0.05 ticks at 1. */
function pick(rng: Rng, lo: number, hi: number, ugliness: number): number {
  const step = ugliness < 0.3 ? 5 : ugliness < 0.6 ? 0.5 : 0.05
  const slots = Math.floor((hi - lo) / step)
  return round2(lo + rng.int(0, Math.max(0, slots)) * step)
}

/** The question types a level may ask, in the order they unlock. */
export const typesFor = (typePool: number): QuestionType[] => QUESTION_TYPES.slice(0, Math.max(1, Math.min(8, Math.round(typePool))))

export function makeQuestion(rng: Rng, type: QuestionType, params: QuestionParams, ctx: QuestionContext): Question {
  const L = ctx.lotSize
  const u = params.ugliness
  const lots = rng.int(1, Math.max(1, params.lotsMax))
  const stop = pick(rng, 5, 30, u)
  const entry = pick(rng, 40, 200, u)
  const cost = rng.int(4, 14) * 10 // rupees for the round trip of one lot
  const costPts = cost / L
  switch (type) {
    case 1: {
      const answer = Math.round(stop * lots * L)
      return { type, steps: 1, unit: '₹', answer, exactTol: 1, closeRel: 0.02,
        prompt: `Stop ${pts(stop)} points, ${lots} lot${lots > 1 ? 's' : ''} of ${L}. Rupee risk?`,
        working: `${pts(stop)} × ${lots} × ${L} = ${rupees(answer)}` }
    }
    case 2: {
      const risk = pick(rng, 5, 20, u) || 5
      const reward = round2(risk * (1 + rng.int(1, 8) / 4))
      const answer = round2(reward / risk)
      return { type, steps: 1, unit: 'R', answer, exactTol: 0.01, closeRel: 0.05,
        prompt: `Entry ${pts(entry)}, stop ${pts(round2(entry - risk))}, target ${pts(round2(entry + reward))}. Reward to risk (1 : ?)`,
        working: `reward ${pts(reward)} ÷ risk ${pts(risk)} = ${answer.toFixed(2)}` }
    }
    case 3: {
      const answer = round2(entry + costPts)
      return { type, steps: 2, unit: 'pts', answer, exactTol: 0.01, closeRel: 0.02,
        prompt: `Buy at ${pts(entry)}. Round trip costs ${rupees(cost)} per lot (lot ${L}). Breakeven premium?`,
        working: `${rupees(cost)} ÷ ${L} = ${costPts.toFixed(2)} pts, so ${pts(entry)} + ${costPts.toFixed(2)} = ${answer.toFixed(2)}` }
    }
    case 4: {
      const perLot = stop * L
      const budget = Math.ceil((perLot * rng.int(1, 6) + rng.int(0, Math.floor(perLot * 0.9))) / 100) * 100
      const answer = Math.floor(budget / perLot)
      return { type, steps: 2, unit: 'lots', answer, exactTol: 0, closeRel: 0,
        prompt: `Budget ${rupees(budget)}, stop ${pts(stop)} points, lot ${L}. How many whole lots?`,
        working: `${pts(stop)} × ${L} = ${rupees(perLot)} per lot; ${rupees(budget)} ÷ ${rupees(perLot)} = ${(budget / perLot).toFixed(2)}, so ${answer}` }
    }
    case 5: {
      const capital = rng.int(2, 20) * 25_000
      const risk = stop * lots * L
      const answer = round2((risk / capital) * 100)
      return { type, steps: 2, unit: '%', answer, exactTol: 0.01, closeRel: 0.05,
        prompt: `Capital ${rupees(capital)}. Stop ${pts(stop)} points, ${lots} lot${lots > 1 ? 's' : ''} of ${L}. Percent of capital at risk?`,
        working: `${pts(stop)} × ${lots} × ${L} = ${rupees(risk)}; ${rupees(risk)} ÷ ${rupees(capital)} = ${answer.toFixed(2)}%` }
    }
    case 6: {
      const delta = round2(rng.int(6, 14) * 0.05)
      const move = rng.int(2, 16) * 5
      if (params.maxSteps >= 3) {
        const gamma = round2(rng.int(1, 6) * 0.002)
        const answer = round2(delta * move + 0.5 * gamma * move * move)
        return { type, steps: 3, unit: 'pts', answer, exactTol: 0.02, closeRel: 0.05,
          prompt: `Delta ${delta.toFixed(2)}, gamma ${gamma.toFixed(3)}. Underlying +${move} points. Option move (delta and gamma)?`,
          working: `${delta.toFixed(2)} × ${move} = ${(delta * move).toFixed(2)}; ½ × ${gamma.toFixed(3)} × ${move}² = ${(0.5 * gamma * move * move).toFixed(2)}; total ${answer.toFixed(2)}` }
      }
      const answer = round2(delta * move)
      return { type, steps: 1, unit: 'pts', answer, exactTol: 0.01, closeRel: 0.05,
        prompt: `Delta ${delta.toFixed(2)}. Underlying +${move} points. Option move?`,
        working: `${delta.toFixed(2)} × ${move} = ${answer.toFixed(2)}` }
    }
    case 7: {
      const l1 = rng.int(1, Math.max(1, params.lotsMax)), l2 = rng.int(1, Math.max(1, params.lotsMax))
      const p1 = entry, p2 = round2(Math.max(5, entry - pick(rng, 5, 25, u)))
      const average = (l1 * p1 + l2 * p2) / (l1 + l2)
      if (params.maxSteps >= 3) {
        const answer = round2(average + costPts)
        return { type, steps: 3, unit: 'pts', answer, exactTol: 0.01, closeRel: 0.02,
          prompt: `${l1} lot${l1 > 1 ? 's' : ''} at ${pts(p1)}, then ${l2} at ${pts(p2)}. Round trip ${rupees(cost)} per lot (lot ${L}). New breakeven?`,
          working: `average ${(l1 * p1 + l2 * p2).toFixed(2)} ÷ ${l1 + l2} = ${average.toFixed(2)}; cost ${costPts.toFixed(2)} pts; breakeven ${answer.toFixed(2)}` }
      }
      const answer = round2(average)
      return { type, steps: 2, unit: 'pts', answer, exactTol: 0.01, closeRel: 0.02,
        prompt: `${l1} lot${l1 > 1 ? 's' : ''} at ${pts(p1)}, then ${l2} lot${l2 > 1 ? 's' : ''} at ${pts(p2)}. New average entry?`,
        working: `(${l1} × ${pts(p1)} + ${l2} × ${pts(p2)}) ÷ ${l1 + l2} = ${answer.toFixed(2)}` }
    }
    case 8: {
      const perLot = stop * L
      const wanted = rng.int(1, Math.max(2, params.lotsMax))
      const budget = Math.ceil((perLot * wanted + rng.int(0, Math.floor(perLot * 0.8))) / 100) * 100
      const fits = Math.floor(budget / perLot)
      if (params.maxSteps >= 3) {
        const answer = Math.round(fits * perLot)
        return { type, steps: 3, unit: '₹', answer, exactTol: 1, closeRel: 0.02,
          prompt: `Budget ${rupees(budget)}, stop ${pts(stop)} points, lot ${L}. Buy the most whole lots that fit: what do you actually risk?`,
          working: `${rupees(perLot)} per lot; ${fits} lot${fits === 1 ? '' : 's'} fit; ${fits} × ${rupees(perLot)} = ${rupees(answer)}` }
      }
      const answer = fits * cost
      return { type, steps: 2, unit: '₹', answer, exactTol: 1, closeRel: 0.02,
        prompt: `Budget ${rupees(budget)}, stop ${pts(stop)} points, lot ${L}; round trip ${rupees(cost)} per lot. Buy the most whole lots that fit: total round-trip cost?`,
        working: `${rupees(perLot)} per lot; ${fits} lot${fits === 1 ? '' : 's'} fit; ${fits} × ${rupees(cost)} = ${rupees(answer)}` }
    }
  }
}

export type Verdict = 'correct' | 'close' | 'wrong' | 'timeout'

export interface QuestionResult {
  type: QuestionType
  verdict: Verdict
  /** 0 to 0.7+0.3: the round score. */
  score: number
  timeMs: number
  entered: number | null
  answer: number
}

/** Parse what the player typed: digits, a dot as the decimal mark, commas as thousands separators (1,605 is 1605), a leading minus; anything else is no answer. */
export function parseEntry(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, '').replace(/[₹%]/g, '')
  if (!/^-?\d*\.?\d+$/.test(cleaned) && !/^-?\d+\.$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

export function judge(question: Question, entered: number | null, timeMs: number, timeLimitSec: number): QuestionResult {
  const base = { type: question.type, timeMs, entered, answer: question.answer }
  if (entered === null) return { ...base, verdict: timeMs >= timeLimitSec * 1000 ? 'timeout' : 'wrong', score: 0 }
  if (timeMs >= timeLimitSec * 1000) return { ...base, verdict: 'timeout', score: 0 }
  const speed = clamp(1 - timeMs / (timeLimitSec * 1000), 0, 1)
  const full = RISK_CALCULATOR.baseCredit + (1 - RISK_CALCULATOR.baseCredit) * speed
  const off = Math.abs(entered - question.answer)
  if (off <= question.exactTol + 1e-9) return { ...base, verdict: 'correct', score: full }
  if (question.closeRel > 0 && off <= Math.abs(question.answer) * question.closeRel + 1e-9) return { ...base, verdict: 'close', score: RISK_CALCULATOR.closeCredit * full }
  return { ...base, verdict: 'wrong', score: 0 }
}

const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** `SessionScore = 100 x mean(roundScore)`. Stats: accuracy per type asked, median time, the most-missed type (0 when none). */
export function summariseRiskCalculator(results: QuestionResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((sum, r) => sum + r.score, 0) / n : 0
  const stats: Record<string, number> = {
    questions: n,
    correct: results.filter(r => r.verdict === 'correct').length,
    median_ms: Math.round(median(results.map(r => r.timeMs))),
  }
  let worst: { type: number; misses: number } = { type: 0, misses: 0 }
  for (const type of QUESTION_TYPES) {
    const asked = results.filter(r => r.type === type)
    if (!asked.length) continue
    const right = asked.filter(r => r.verdict === 'correct' || r.verdict === 'close').length
    stats[`acc_q${type}`] = Math.round((right / asked.length) * 100)
    const misses = asked.length - right
    if (misses > worst.misses) worst = { type, misses }
  }
  stats.most_missed = worst.type
  return { score: toSessionScore(100 * mean), stats }
}

/** A question list for a session: the unlocked types in turn (shuffled), so each type comes up evenly. */
export function planTypes(rng: Rng, count: number, typePool: number): QuestionType[] {
  const pool = typesFor(typePool)
  const out: QuestionType[] = []
  while (out.length < count) out.push(...rng.shuffle(pool))
  return out.slice(0, count)
}
