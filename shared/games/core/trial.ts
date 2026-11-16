/**
 * Trial-based games (spec 17.3): a pure, seeded engine produces trials and judges responses; a View shows them and
 * reports timing. Nothing here touches the DOM, so the same engine runs in the browser and in the simulated-player tests.
 */

/** A response, or `'timeout'` when none arrived inside the response window. */
export type TrialResponse<R> = R | 'timeout'

export interface TrialTiming {
  /** How long the stimulus stays visible; `null` = until it is answered or the window ends. */
  displayMs: number | null
  /** Deadline for a response, counted from stimulus onset. */
  windowMs: number
  /** Pause after the trial before the next one starts. */
  gapMs: number
  /** A banner (new rule, cue) shown for this long before the stimulus appears; the block clock keeps running. */
  preMs?: number
  /**
   * The trial always lasts its whole window, whatever the player does (n-back keeps a fixed pace). Responses are collected
   * during the window and judged together when it ends.
   */
  fixedCadence?: boolean
  /**
   * A long puzzle (tens of seconds to minutes) whose answer time is not a reaction time: a stalled frame must not throw the whole
   * puzzle away and start another (the 100 ms bad-frame rule of spec 17.3 is for stimuli timed in milliseconds).
   */
  tolerateStalls?: boolean
}

/** One step of a staged round (memory games, Track the Dots): shown for `ms`, or until the player submits when `ms` is null. */
export interface StageSpec {
  name: string
  ms: number | null
  /** Stimulus presentation: a long frame here discards the round and replaces it with a fresh one (spec 17.3). */
  critical?: boolean
}

export interface TrialOutcome {
  correct: boolean
  /** Game-specific class, e.g. `hit` / `miss` / `fa` / `cr` for detection tasks. */
  tag?: string
  /** Set by the block when the response came sooner than a human can react (`rt.ts`): an error, excluded from RT statistics. */
  anticipated?: boolean
}

export interface TrialEngine<Trial, R> {
  /** The next trial, or `null` when the session is over (strikes, trial cap). A timed block also ends by the clock. */
  next(): Trial | null
  timing(trial: Trial): TrialTiming
  evaluate(trial: Trial, response: TrialResponse<R>, rtMs: number): TrialOutcome
  /** Pause after a judged trial, when it depends on the outcome (a wrong answer is shown for a second). Default: `timing.gapMs`. */
  gapAfter?(trial: Trial, outcome: TrialOutcome): number
  progress?(): { span?: number; strikes?: number; lives?: number; trial?: number; of?: number }
  /** Staged rounds only: the steps of this round, in order. The last one is where the player answers (`ms: null`). */
  stages?(trial: Trial): StageSpec[]
}

export interface TrialLogEntry<Trial, R> {
  /** 1-based position among the trials that count. */
  n: number
  trial: Trial
  response: TrialResponse<R>
  /** Reaction time in ms from stimulus onset; `null` for a timeout. */
  rtMs: number | null
  outcome: TrialOutcome
  /** Block clock (ms) when the trial ended. */
  atMs: number
}

/** One row of the result screen's per-trial review. */
export interface ReviewRow {
  n: number
  shown: string
  answered: string
  correctAnswer: string
  correct: boolean
  rtMs: number | null
}
