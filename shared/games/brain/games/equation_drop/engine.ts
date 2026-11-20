/**
 * Equation Drop (Math, spec 17.5 #14): equations fall; type an answer and press Enter to clear EVERY falling equation with that
 * value. An equation that lands costs a life; three lives or 90 seconds. Pure, seeded and clock-free: the View steps a
 * `DropSim` with the frame time, the tests step it on a virtual clock.
 *
 * As built: a typed answer that clears nothing breaks the combo, costs 0.25 of a point and locks the input for 300 ms (the
 * spec has no such cost, but without it spamming numbers would clear drops by luck); a "combo" is the run of clears since the
 * last landing or wrong entry, so two equations with the same answer cleared together build it by two.
 */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, EQUATION_DROP_PARAMS } from '../../config/difficulty.brain'
import { answersEqual, formatNumber, makeProblem, makeReverse, specFromParams } from '../../engine/arithmetic'
import { median } from '../../engine/rt'
import { round3 } from '../../engine/scoringBrain'

export const LIVES = 3
export const WRONG_LOCK_MS = 300
export const WRONG_PENALTY = 0.25
export const FIRST_SPAWN_MS = 600
export const SPAWN_SLACK = 1.1
/** Three lives lost before this many ms caps the score. */
export const EARLY_DEATH_MS = 60000
export const EARLY_DEATH_CAP = 70
export const BLOCK_MS = BLOCK_SECONDS.equation_drop * 1000

export type EdResponse = number
export interface EdTrial {
  /** A falling equation, or a typed answer that matched nothing. */
  kind: 'drop' | 'typed'
  id: number
  text: string
  answer: number
  /** An answer falls and the player types the missing number. */
  reverse: boolean
  spawnMs: number
  /** How long this drop takes to reach the bottom. */
  fallMs: number
  /** Horizontal position, 0 to 1. */
  lane: number
  /** Position in the combo when it was cleared (set on the log entry). */
  combo?: number
}

export interface DropGenerator { spawn(elapsedMs: number, taken: number[]): EdTrial }

export function createDropGenerator(params: Record<string, number>, rng: Rng): DropGenerator {
  const spec = specFromParams({ ...params, carry: 1, negatives: 0, decimals: 0 })
  const reverseOn = params.reverse >= 1
  let nextId = 1
  return {
    spawn(elapsedMs, taken) {
      const blockFraction = clamp01(elapsedMs / BLOCK_MS)
      const fallMs = Math.round(params.fallStartMs + (params.fallEndMs - params.fallStartMs) * blockFraction)
      let problem = makeProblem(rng, spec)
      let guard = 0
      while (problem.answer < 0 && guard++ < 10) problem = makeProblem(rng, spec)
      let reverse = false
      if (reverseOn && rng.chance(0.3)) {
        const flipped = makeReverse(problem, rng)
        if (flipped) { problem = flipped; reverse = true }
      }
      // Keep neighbours apart: try a few lanes and take the one furthest from the drops already falling.
      let lane = rng.next(), best = -1
      for (let i = 0; i < 6; i++) {
        const candidate = 0.08 + rng.next() * 0.84
        const gap = taken.length ? Math.min(...taken.map(x => Math.abs(x - candidate))) : 1
        if (gap > best) { best = gap; lane = candidate }
      }
      return { kind: 'drop', id: nextId++, text: problem.text, answer: problem.answer, reverse, spawnMs: elapsedMs, fallMs, lane }
    },
  }
}

export interface LiveDrop { trial: EdTrial; /** 0 at the top, 1 at the bottom */ y: number }

export interface DropSim {
  step(dtMs: number): void
  /** Type an answer. Returns the equations it cleared (empty for a miss or while locked). */
  submit(value: number): EdTrial[]
  readonly drops: LiveDrop[]
  readonly lives: number
  readonly elapsedMs: number
  readonly combo: number
  readonly locked: boolean
  readonly over: boolean
  readonly log: TrialLogEntry<EdTrial, EdResponse>[]
}

export function createDropSim(params: Record<string, number>, rng: Rng): DropSim {
  const generator = createDropGenerator(params, rng)
  const maxDrops = Math.max(1, Math.round(params.maxDrops))
  const alive: EdTrial[] = []
  const log: TrialLogEntry<EdTrial, EdResponse>[] = []
  let elapsed = 0, lastSpawn = -Infinity, lives = LIVES, combo = 0, lockedUntil = 0, over = false
  const fallAt = (ms: number) => params.fallStartMs + (params.fallEndMs - params.fallStartMs) * clamp01(ms / BLOCK_MS)
  // Never faster than a perfect player (RT_fast) can clear them, however short the fall.
  const spawnGap = () => Math.max(fallAt(elapsed) / (maxDrops + 0.5), params.rtFast * SPAWN_SLACK)
  const push = (trial: EdTrial, response: EdResponse | 'timeout', rtMs: number | null, outcome: TrialOutcome) =>
    log.push({ n: log.length + 1, trial, response, rtMs, outcome, atMs: elapsed })

  return {
    step(dtMs) {
      if (over) return
      elapsed += dtMs
      for (let i = alive.length - 1; i >= 0; i--) {
        const drop = alive[i]
        if (elapsed - drop.spawnMs >= drop.fallMs) {
          alive.splice(i, 1)
          lives -= 1; combo = 0
          push(drop, 'timeout', null, { correct: false, tag: 'landed' })
        }
      }
      if (lives <= 0 || elapsed >= BLOCK_MS) { over = true; return }
      if (alive.length < maxDrops && (lastSpawn === -Infinity ? elapsed >= FIRST_SPAWN_MS : elapsed - lastSpawn >= spawnGap())) {
        alive.push(generator.spawn(elapsed, alive.map(d => d.lane)))
        lastSpawn = elapsed
      }
    },
    submit(value) {
      if (over || elapsed < lockedUntil) return []
      const hit = alive.filter(drop => answersEqual(drop.answer, value))
      if (!hit.length) {
        combo = 0
        lockedUntil = elapsed + WRONG_LOCK_MS
        push({ kind: 'typed', id: -1, text: '(typed)', answer: value, reverse: false, spawnMs: elapsed, fallMs: 0, lane: 0 }, value, null, { correct: false, tag: 'wrong' })
        return []
      }
      for (const drop of hit) {
        alive.splice(alive.indexOf(drop), 1)
        combo += 1
        push({ ...drop, combo }, value, elapsed - drop.spawnMs, { correct: true, tag: 'cleared' })
      }
      return hit
    },
    get drops() { return alive.map(trial => ({ trial, y: clamp01((elapsed - trial.spawnMs) / trial.fallMs) })) },
    get lives() { return lives },
    get elapsedMs() { return elapsed },
    get combo() { return combo },
    get locked() { return elapsed < lockedUntil },
    get over() { return over },
    get log() { return log },
  }
}

/** The weighted total of clears: each is worth 1 + 0.1 x min(combo, 5); each wrong entry costs 0.25. Never below 0. */
export function weightedClears(log: TrialLogEntry<EdTrial, EdResponse>[]): number {
  const gained = log.filter(entry => entry.outcome.tag === 'cleared').reduce((sum, entry) => sum + 1 + 0.1 * Math.min(entry.trial.combo ?? 1, 5), 0)
  return Math.max(0, gained - WRONG_PENALTY * log.filter(entry => entry.outcome.tag === 'wrong').length)
}

export function summariseEquationDrop(log: TrialLogEntry<EdTrial, EdResponse>[], level: number): SessionSummary {
  const p = paramsAt(EQUATION_DROP_PARAMS, level)
  const cleared = log.filter(entry => entry.outcome.tag === 'cleared')
  const landed = log.filter(entry => entry.outcome.tag === 'landed')
  const wrong = log.filter(entry => entry.outcome.tag === 'wrong')
  const weighted = weightedClears(log)
  let score = toSessionScore(100 * clamp01(weighted / Math.max(1, p.target)))
  const diedAt = landed.length >= LIVES ? landed[LIVES - 1].atMs : null
  if (diedAt !== null && diedAt < EARLY_DEATH_MS) score = Math.min(score, EARLY_DEATH_CAP)
  // "Entries" are submissions: one Enter that clears two equations is one entry.
  const entries = new Set(cleared.map(entry => entry.atMs)).size + wrong.length
  const clearMs = median(cleared.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n,
    shown: entry.trial.kind === 'typed' ? 'typed an answer that matched nothing' : `${entry.trial.text}${entry.trial.reverse ? ' (type the missing number)' : ''}`,
    answered: entry.response === 'timeout' ? 'landed' : formatNumber(entry.response),
    correctAnswer: entry.trial.kind === 'typed' ? '-' : formatNumber(entry.trial.answer), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      cleared: cleared.length, longest_combo: Math.max(0, ...cleared.map(entry => entry.trial.combo ?? 1)), lives_lost: Math.min(LIVES, landed.length),
      entries, typed_accuracy_pct: entries ? Math.round(((entries - wrong.length) / entries) * 100) : 0, wrong_entries: wrong.length,
      median_clear_ms: Math.round(clearMs ?? 0), weighted: Math.round(weighted * 10) / 10, died: diedAt !== null ? 1 : 0,
      survived_s: Math.round((diedAt ?? Math.min(BLOCK_MS, log.length ? log[log.length - 1].atMs : 0)) / 1000), accuracy: entries ? round3((entries - wrong.length) / entries) : 0,
    },
    review,
  }
}

/**
 * The generic engine view of the game, used by the definition and the registry checks: each trial is one drop, answered by
 * typing its value (a landed drop is a timeout). The real game is played through `createDropSim`.
 */
export function createEquationDropEngine(params: Record<string, number>, rng: Rng): TrialEngine<EdTrial, EdResponse> {
  const generator = createDropGenerator(params, rng)
  let clock = FIRST_SPAWN_MS
  return {
    next() {
      const trial = generator.spawn(clock, [])
      clock += Math.max(trial.fallMs / (Math.round(params.maxDrops) + 0.5), params.rtFast * SPAWN_SLACK)
      return trial
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.fallMs, gapMs: 0 }),
    evaluate: (trial, response): TrialOutcome => (response !== 'timeout' && answersEqual(response, trial.answer) ? { correct: true, tag: 'cleared' } : { correct: false, tag: response === 'timeout' ? 'landed' : 'wrong' }),
  }
}
